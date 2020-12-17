(function(){function r(e,n,t){function o(i,f){if(!n[i]){if(!e[i]){var c="function"==typeof require&&require;if(!f&&c)return c(i,!0);if(u)return u(i,!0);var a=new Error("Cannot find module '"+i+"'");throw a.code="MODULE_NOT_FOUND",a}var p=n[i]={exports:{}};e[i][0].call(p.exports,function(r){var n=e[i][1][r];return o(n||r)},p,p.exports,r,e,n,t)}return n[i].exports}for(var u="function"==typeof require&&require,i=0;i<t.length;i++)o(t[i]);return o}return r})()({1:[function(require,module,exports){
//-------------------------------- Background initialisation --------------------------------//
"use strict";

require("chrome-extension-async");
const sha1 = require("sha1");
const idb = require("idb");
const BrowserpassURL = require("@browserpass/url");
const helpers = require("./helpers");

// native application id
var appID = "com.github.browserpass.native";

// OTP extension id
var otpID = [
    "afjjoildnccgmjbblnklbohcbjehjaph", // webstore releases
    "jbnpmhhgnchcoljeobafpinmchnpdpin", // github releases
    "fcmmcnalhjjejhpnlfnddimcdlmpkbdf", // local unpacked
    "browserpass-otp@maximbaz.com" // firefox
];

// default settings
var defaultSettings = {
    autoSubmit: false,
    gpgPath: null,
    stores: {},
    foreignFills: {},
    username: null,
    theme: "dark"
};

var authListeners = {};

var badgeCache = {
    files: null,
    settings: null,
    expires: Date.now(),
    isRefreshing: false
};

// the last text copied to the clipboard is stored here in order to be cleared after 60 seconds
let lastCopiedText = null;

chrome.browserAction.setBadgeBackgroundColor({
    color: "#666"
});

// watch for tab updates
chrome.tabs.onUpdated.addListener((tabId, info) => {
    // unregister any auth listeners for this tab
    if (info.status === "complete") {
        if (authListeners[tabId]) {
            chrome.webRequest.onAuthRequired.removeListener(authListeners[tabId]);
            delete authListeners[tabId];
        }
    }

    // redraw badge counter
    updateMatchingPasswordsCount(tabId);
});

// handle incoming messages
chrome.runtime.onMessage.addListener(function(message, sender, sendResponse) {
    receiveMessage(message, sender, sendResponse);

    // allow async responses after this function returns
    return true;
});

// handle keyboard shortcuts
chrome.commands.onCommand.addListener(async command => {
    switch (command) {
        case "fillBest":
            try {
                const settings = await getFullSettings();
                if (settings.tab.url.match(/^(chrome|about):/)) {
                    // only fill on real domains
                    return;
                }
                handleMessage(settings, { action: "listFiles" }, listResults => {
                    const logins = helpers.prepareLogins(listResults.files, settings);
                    const bestLogin = helpers.filterSortLogins(logins, "", true)[0];
                    if (bestLogin) {
                        handleMessage(settings, { action: "fill", login: bestLogin }, () => {});
                    }
                });
            } catch (e) {
                console.log(e);
            }
            break;
    }
});

// handle fired alarms
chrome.alarms.onAlarm.addListener(alarm => {
    if (alarm.name === "clearClipboard") {
        if (readFromClipboard() === lastCopiedText) {
            copyToClipboard("", false);
        }
        lastCopiedText = null;
    }
});

chrome.runtime.onInstalled.addListener(onExtensionInstalled);

//----------------------------------- Function definitions ----------------------------------//

/**
 * Set badge text with the number of matching password entries
 *
 * @since 3.0.0
 *
 * @param int  tabId Tab id
 * @param bool forceRefresh force invalidate cache
 * @return void
 */
async function updateMatchingPasswordsCount(tabId, forceRefresh = false) {
    if (badgeCache.isRefreshing) {
        return;
    }

    try {
        if (forceRefresh || Date.now() > badgeCache.expires) {
            badgeCache.isRefreshing = true;

            let settings = await getFullSettings();
            let response = await hostAction(settings, "list");
            if (response.status != "ok") {
                throw new Error(JSON.stringify(response));
            }

            const CACHE_TTL_MS = 60 * 1000;
            badgeCache = {
                files: response.data.files,
                settings: settings,
                expires: Date.now() + CACHE_TTL_MS,
                isRefreshing: false
            };
        }

        try {
            const tab = await chrome.tabs.get(tabId);
            badgeCache.settings.origin = new URL(tab.url).origin;
        } catch (e) {
            throw new Error(`Unable to determine domain of the tab with id ${tabId}`);
        }

        // Compule badge counter
        const files = helpers.ignoreFiles(badgeCache.files, badgeCache.settings);
        const logins = helpers.prepareLogins(files, badgeCache.settings);
        const matchedPasswordsCount = logins.reduce(
            (acc, login) => acc + (login.recent.count || login.inCurrentHost ? 1 : 0),
            0
        );

        // Set badge for the current tab
        chrome.browserAction.setBadgeText({
            text: "" + (matchedPasswordsCount || ""),
            tabId: tabId
        });
    } catch (e) {
        console.log(e);
    }
}

/**
 * Copy text to clipboard and optionally clear it from the clipboard after one minute
 *
 * @since 3.2.0
 *
 * @param string text Text to copy
 * @param boolean clear Whether to clear the clipboard after one minute
 * @return void
 */
function copyToClipboard(text, clear = true) {
    document.addEventListener(
        "copy",
        function(e) {
            e.clipboardData.setData("text/plain", text);
            e.preventDefault();
        },
        { once: true }
    );
    document.execCommand("copy");

    if (clear) {
        lastCopiedText = text;
        chrome.alarms.create("clearClipboard", { delayInMinutes: 1 });
    }
}

/**
 * Read plain text from clipboard
 *
 * @since 3.2.0
 *
 * @return string The current plaintext content of the clipboard
 */
function readFromClipboard() {
    const ta = document.createElement("textarea");
    // these lines are carefully crafted to make paste work in both Chrome and Firefox
    ta.contentEditable = true;
    ta.textContent = "";
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("paste");
    const content = ta.value;
    document.body.removeChild(ta);
    return content;
}

/**
 * Save login to recent list for current domain
 *
 * @since 3.0.0
 *
 * @param object settings Settings object
 * @param string host     Hostname
 * @param object login    Login object
 * @param bool   remove   Remove this item from recent history
 * @return void
 */
async function saveRecent(settings, login, remove = false) {
    var ignoreInterval = 60000; // 60 seconds - don't increment counter twice within this window

    // save store timestamp
    localStorage.setItem("recent:" + login.store.id, JSON.stringify(Date.now()));

    // update login usage count & timestamp
    if (Date.now() > login.recent.when + ignoreInterval) {
        login.recent.count++;
    }
    login.recent.when = Date.now();
    settings.recent[sha1(settings.origin + sha1(login.store.id + sha1(login.login)))] =
        login.recent;

    // save to local storage
    localStorage.setItem("recent", JSON.stringify(settings.recent));

    // a new entry was added to the popup matching list, need to refresh the count
    if (!login.inCurrentHost && login.recent.count === 1) {
        updateMatchingPasswordsCount(settings.tab.id, true);
    }

    // save to usage log
    try {
        const DB_VERSION = 1;
        const db = await idb.openDB("browserpass", DB_VERSION, {
            upgrade(db) {
                db.createObjectStore("log", { keyPath: "time" });
            }
        });
        await db.add("log", { time: Date.now(), host: settings.origin, login: login.login });
    } catch {
        // ignore any errors and proceed without saving a log entry to Indexed DB
    }
}

/**
 * Call injected code to fill the form
 *
 * @param object  settings      Settings object
 * @param object  request       Request details
 * @param boolean allFrames     Dispatch to all frames
 * @param boolean allowForeign  Allow foreign-origin iframes
 * @param boolean allowNoSecret Allow forms that don't contain a password field
 * @return array list of filled fields
 */
async function dispatchFill(settings, request, allFrames, allowForeign, allowNoSecret) {
    request = Object.assign(deepCopy(request), {
        allowForeign: allowForeign,
        allowNoSecret: allowNoSecret,
        foreignFills: settings.foreignFills[settings.origin] || {}
    });

    let perFrameResults = await chrome.tabs.executeScript(settings.tab.id, {
        allFrames: allFrames,
        code: `window.browserpass.fillLogin(${JSON.stringify(request)});`
    });

    // merge filled fields into a single array
    let filledFields = perFrameResults
        .reduce((merged, frameResult) => merged.concat(frameResult.filledFields), [])
        .filter((val, i, merged) => merged.indexOf(val) === i);

    // if user answered a foreign-origin confirmation,
    // store the answers in the settings
    let foreignFillsChanged = false;
    for (let frame of perFrameResults) {
        if (typeof frame.foreignFill !== "undefined") {
            if (typeof settings.foreignFills[settings.origin] === "undefined") {
                settings.foreignFills[settings.origin] = {};
            }
            settings.foreignFills[settings.origin][frame.foreignOrigin] = frame.foreignFill;
            foreignFillsChanged = true;
        }
    }
    if (foreignFillsChanged) {
        await saveSettings(settings);
    }

    return filledFields;
}

/**
 * Call injected code to focus or submit the form
 *
 * @param object  settings      Settings object
 * @param object  request       Request details
 * @param boolean allFrames     Dispatch to all frames
 * @param boolean allowForeign  Allow foreign-origin iframes
 * @return void
 */
async function dispatchFocusOrSubmit(settings, request, allFrames, allowForeign) {
    request = Object.assign(deepCopy(request), {
        allowForeign: allowForeign,
        foreignFills: settings.foreignFills[settings.origin] || {}
    });

    let perFrameResults = await chrome.tabs.executeScript(settings.tab.id, {
        allFrames: allFrames,
        code: `window.browserpass.focusOrSubmit(${JSON.stringify(request)});`
    });

    // if necessary, dispatch Enter keypress to autosubmit the form
    // currently only works on Chromium and requires debugger permission
    try {
        for (let frame of perFrameResults) {
            if (frame.needPressEnter) {
                chrome.debugger.attach({ tabId: settings.tab.id }, "1.2");
                for (let type of ["keyDown", "keyUp"]) {
                    chrome.debugger.sendCommand(
                        { tabId: settings.tab.id },
                        "Input.dispatchKeyEvent",
                        {
                            type: type,
                            windowsVirtualKeyCode: 13,
                            nativeVirtualKeyCode: 13
                        }
                    );
                }
                chrome.debugger.detach({ tabId: settings.tab.id });
                break;
            }
        }
    } catch (e) {}
}

/**
 * Inject script
 *
 * @param object settings Settings object
 * @param boolean allFrames Inject in all frames
 * @return object Cancellable promise
 */
async function injectScript(settings, allFrames) {
    const MAX_WAIT = 1000;

    return new Promise(async (resolve, reject) => {
        const waitTimeout = setTimeout(reject, MAX_WAIT);
        await chrome.tabs.executeScript(settings.tab.id, {
            allFrames: allFrames,
            file: "js/inject.dist.js"
        });
        clearTimeout(waitTimeout);
        resolve(true);
    });
}

/**
 * Fill form fields
 *
 * @param object settings Settings object
 * @param object login    Login object
 * @param array  fields   List of fields to fill
 * @return array List of filled fields
 */
async function fillFields(settings, login, fields) {
    // inject script
    try {
        await injectScript(settings, false);
    } catch {
        throw new Error("Unable to inject script in the top frame");
    }

    let injectedAllFrames = false;
    try {
        await injectScript(settings, true);
        injectedAllFrames = true;
    } catch {
        // we'll proceed with trying to fill only the top frame
    }

    // build fill request
    var fillRequest = {
        origin: new URL(settings.tab.url).origin,
        login: login,
        fields: fields
    };

    let allFrames = false;
    let allowForeign = false;
    let allowNoSecret = !fields.includes("secret");
    let filledFields = [];
    let importantFieldToFill = fields.includes("openid") ? "openid" : "secret";

    // fill form via injected script
    filledFields = filledFields.concat(
        await dispatchFill(settings, fillRequest, allFrames, allowForeign, allowNoSecret)
    );

    if (injectedAllFrames) {
        // try again using same-origin frames if we couldn't fill an "important" field
        if (!filledFields.includes(importantFieldToFill)) {
            allFrames = true;
            filledFields = filledFields.concat(
                await dispatchFill(settings, fillRequest, allFrames, allowForeign, allowNoSecret)
            );
        }

        // try again using all available frames if we couldn't fill an "important" field
        if (
            !filledFields.includes(importantFieldToFill) &&
            settings.foreignFills[settings.origin] !== false
        ) {
            allowForeign = true;
            filledFields = filledFields.concat(
                await dispatchFill(settings, fillRequest, allFrames, allowForeign, allowNoSecret)
            );
        }
    }

    // try again, but don't require a password field (if it was required until now)
    if (!allowNoSecret) {
        allowNoSecret = true;

        // try again using only the top frame
        if (!filledFields.length) {
            allFrames = false;
            allowForeign = false;
            filledFields = filledFields.concat(
                await dispatchFill(settings, fillRequest, allFrames, allowForeign, allowNoSecret)
            );
        }

        if (injectedAllFrames) {
            // try again using same-origin frames
            if (!filledFields.length) {
                allFrames = true;
                filledFields = filledFields.concat(
                    await dispatchFill(
                        settings,
                        fillRequest,
                        allFrames,
                        allowForeign,
                        allowNoSecret
                    )
                );
            }

            // try again using all available frames
            if (!filledFields.length && settings.foreignFills[settings.origin] !== false) {
                allowForeign = true;
                filledFields = filledFields.concat(
                    await dispatchFill(
                        settings,
                        fillRequest,
                        allFrames,
                        allowForeign,
                        allowNoSecret
                    )
                );
            }
        }
    }

    if (!filledFields.length) {
        throw new Error(`No fillable forms available for fields: ${fields.join(", ")}`);
    }

    // build focus or submit request
    let focusOrSubmitRequest = {
        origin: new URL(settings.tab.url).origin,
        autoSubmit: getSetting("autoSubmit", login, settings),
        filledFields: filledFields
    };

    // try to focus or submit form with the settings that were used to fill it
    await dispatchFocusOrSubmit(settings, focusOrSubmitRequest, allFrames, allowForeign);

    return filledFields;
}

/**
 * Get Local settings from the extension
 *
 * @since 3.0.0
 *
 * @return object Local settings from the extension
 */
function getLocalSettings() {
    var settings = deepCopy(defaultSettings);
    for (var key in settings) {
        var value = localStorage.getItem(key);
        if (value !== null) {
            settings[key] = JSON.parse(value);
        }
    }

    return settings;
}

/**
 * Get full settings from the extension and host application
 *
 * @since 3.0.0
 *
 * @return object Full settings object
 */
async function getFullSettings() {
    var settings = getLocalSettings();
    var configureSettings = Object.assign(deepCopy(settings), {
        defaultStore: {}
    });
    var response = await hostAction(configureSettings, "configure");
    if (response.status != "ok") {
        settings.hostError = response;
    }
    settings.version = response.version;

    // Fill store settings, only makes sense if 'configure' succeeded
    if (response.status === "ok") {
        if (Object.keys(settings.stores).length > 0) {
            // there are user-configured stores present
            for (var storeId in settings.stores) {
                if (response.data.storeSettings.hasOwnProperty(storeId)) {
                    var fileSettings = JSON.parse(response.data.storeSettings[storeId]);
                    if (typeof settings.stores[storeId].settings !== "object") {
                        settings.stores[storeId].settings = {};
                    }
                    var storeSettings = settings.stores[storeId].settings;
                    for (var settingKey in fileSettings) {
                        if (!storeSettings.hasOwnProperty(settingKey)) {
                            storeSettings[settingKey] = fileSettings[settingKey];
                        }
                    }
                }
            }
        } else {
            // no user-configured stores, so use the default store
            settings.stores.default = {
                id: "default",
                name: "pass",
                path: response.data.defaultStore.path
            };
            var fileSettings = JSON.parse(response.data.defaultStore.settings);
            if (typeof settings.stores.default.settings !== "object") {
                settings.stores.default.settings = {};
            }
            var storeSettings = settings.stores.default.settings;
            for (var settingKey in fileSettings) {
                if (!storeSettings.hasOwnProperty(settingKey)) {
                    storeSettings[settingKey] = fileSettings[settingKey];
                }
            }
        }
    }

    // Fill recent data
    for (var storeId in settings.stores) {
        var when = localStorage.getItem("recent:" + storeId);
        if (when) {
            settings.stores[storeId].when = JSON.parse(when);
        } else {
            settings.stores[storeId].when = 0;
        }
    }
    settings.recent = localStorage.getItem("recent");
    if (settings.recent) {
        settings.recent = JSON.parse(settings.recent);
    } else {
        settings.recent = {};
    }

    // Fill current tab info
    try {
        settings.tab = (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
        let originInfo = new BrowserpassURL(settings.tab.url);
        settings.host = originInfo.host; // TODO remove this after OTP extension is migrated
        settings.origin = originInfo.origin;
    } catch (e) {}

    return settings;
}

/**
 * Get most relevant setting value
 *
 * @param string key      Setting key
 * @param object login    Login object
 * @param object settings Settings object
 * @return object Setting value
 */
function getSetting(key, login, settings) {
    if (typeof login.settings[key] !== "undefined") {
        return login.settings[key];
    }
    if (typeof settings.stores[login.store.id].settings[key] !== "undefined") {
        return settings.stores[login.store.id].settings[key];
    }

    return settings[key];
}

/**
 * Deep copy an object
 *
 * @since 3.0.0
 *
 * @param object obj an object to copy
 * @return object a new deep copy
 */
function deepCopy(obj) {
    return JSON.parse(JSON.stringify(obj));
}

/**
 * Handle modal authentication requests (e.g. HTTP basic)
 *
 * @since 3.0.0
 *
 * @param object requestDetails Auth request details
 * @return object Authentication credentials or {}
 */
function handleModalAuth(requestDetails) {
    var launchHost = requestDetails.url.match(/:\/\/([^\/]+)/)[1];

    // don't attempt authentication against the same login more than once
    if (!this.login.allowFill) {
        return {};
    }
    this.login.allowFill = false;

    // don't attempt authentication outside the main frame
    if (requestDetails.type !== "main_frame") {
        return {};
    }

    // ensure the auth domain is the same, or ask the user for permissions to continue
    if (launchHost !== requestDetails.challenger.host) {
        var message =
            "You are about to send login credentials to a domain that is different than " +
            "the one you launched from the browserpass extension. Do you wish to proceed?\n\n" +
            "Realm: " +
            requestDetails.realm +
            "\n" +
            "Launched URL: " +
            this.url +
            "\n" +
            "Authentication URL: " +
            requestDetails.url;
        if (!confirm(message)) {
            return {};
        }
    }

    // ask the user before sending credentials over an insecure connection
    if (!requestDetails.url.match(/^https:/i)) {
        var message =
            "You are about to send login credentials via an insecure connection!\n\n" +
            "Are you sure you want to do this? If there is an attacker watching your " +
            "network traffic, they may be able to see your username and password.\n\n" +
            "URL: " +
            requestDetails.url;
        if (!confirm(message)) {
            return {};
        }
    }

    // supply credentials
    return {
        authCredentials: {
            username: this.login.fields.login,
            password: this.login.fields.secret
        }
    };
}

/**
 * Handle a message from elsewhere within the extension
 *
 * @since 3.0.0
 *
 * @param object          settings     Settings object
 * @param mixed           message      Incoming message
 * @param function(mixed) sendResponse Callback to send response
 * @return void
 */
async function handleMessage(settings, message, sendResponse) {
    // check that action is present
    if (typeof message !== "object" || !message.hasOwnProperty("action")) {
        sendResponse({ status: "error", message: "Action is missing" });
        return;
    }

    // fetch file & parse fields if a login entry is present
    try {
        if (typeof message.login !== "undefined") {
            await parseFields(settings, message.login);
        }
    } catch (e) {
        sendResponse({
            status: "error",
            message: "Unable to fetch and parse login fields: " + e.toString()
        });
        return;
    }

    // route action
    switch (message.action) {
        case "getSettings":
            sendResponse({
                status: "ok",
                settings: settings
            });
            break;
        case "saveSettings":
            try {
                await saveSettings(message.settings);
                sendResponse({ status: "ok" });
            } catch (e) {
                sendResponse({
                    status: "error",
                    message: e.message
                });
            }
            break;
        case "listFiles":
            try {
                var response = await hostAction(settings, "list");
                if (response.status != "ok") {
                    throw new Error(JSON.stringify(response)); // TODO handle host error
                }
                let files = helpers.ignoreFiles(response.data.files, settings);
                sendResponse({ status: "ok", files });
            } catch (e) {
                sendResponse({
                    status: "error",
                    message: "Unable to enumerate password files" + e.toString()
                });
            }
            break;
        case "copyPassword":
            try {
                copyToClipboard(message.login.fields.secret);
                await saveRecent(settings, message.login);
                sendResponse({ status: "ok" });
            } catch (e) {
                sendResponse({
                    status: "error",
                    message: "Unable to copy password"
                });
            }
            break;
        case "copyUsername":
            try {
                copyToClipboard(message.login.fields.login);
                await saveRecent(settings, message.login);
                sendResponse({ status: "ok" });
            } catch (e) {
                sendResponse({
                    status: "error",
                    message: "Unable to copy username"
                });
            }
            break;

        case "launch":
        case "launchInNewTab":
            try {
                var url = message.login.fields.url || message.login.host;
                if (!url) {
                    throw new Error("No URL is defined for this entry");
                }
                if (!url.match(/:\/\//)) {
                    url = "http://" + url;
                }

                const tab =
                    message.action === "launch"
                        ? await chrome.tabs.update(settings.tab.id, { url: url })
                        : await chrome.tabs.create({ url: url });

                if (authListeners[tab.id]) {
                    chrome.tabs.onUpdated.removeListener(authListeners[tab.id]);
                    delete authListeners[tab.id];
                }
                authListeners[tab.id] = handleModalAuth.bind({
                    url: url,
                    login: message.login
                });
                chrome.webRequest.onAuthRequired.addListener(
                    authListeners[tab.id],
                    { urls: ["*://*/*"], tabId: tab.id },
                    ["blocking"]
                );
                sendResponse({ status: "ok" });
            } catch (e) {
                sendResponse({
                    status: "error",
                    message: "Unable to launch URL: " + e.toString()
                });
            }
            break;
        case "fill":
            try {
                let fields = message.login.fields.openid ? ["openid"] : ["login", "secret"];

                // dispatch initial fill request
                var filledFields = await fillFields(settings, message.login, fields);
                await saveRecent(settings, message.login);

                // no need to check filledFields, because fillFields() already throws an error if empty
                sendResponse({ status: "ok", filledFields: filledFields });
            } catch (e) {
                try {
                    sendResponse({
                        status: "error",
                        message: e.toString()
                    });
                } catch (e) {
                    // TODO An error here is typically a closed message port, due to a popup taking focus
                    // away from the extension menu and the menu closing as a result. Need to investigate
                    // whether triggering the extension menu from the background script is possible.
                    console.log(e);
                }
            }
            break;
        case "clearUsageData":
            try {
                await clearUsageData();
                sendResponse({ status: "ok" });
            } catch (e) {
                sendResponse({
                    status: "error",
                    message: e.message
                });
            }
            break;
        default:
            sendResponse({
                status: "error",
                message: "Unknown action: " + message.action
            });
            break;
    }

    // trigger browserpass-otp
    if (typeof message.login !== "undefined" && message.login.fields.hasOwnProperty("otp")) {
        triggerOTPExtension(settings, message.action, message.login.fields.otp);
    }
}

/**
 * Send a request to the host app
 *
 * @since 3.0.0
 *
 * @param object settings Live settings object
 * @param string action   Action to run
 * @param params object   Additional params to pass to the host app
 * @return Promise
 */
function hostAction(settings, action, params = {}) {
    var request = {
        settings: settings,
        action: action
    };
    for (var key in params) {
        request[key] = params[key];
    }

    return chrome.runtime.sendNativeMessage(appID, request);
}

/**
 * Fetch file & parse fields
 *
 * @since 3.0.0
 *
 * @param object settings Settings object
 * @param object login    Login object
 * @return void
 */
async function parseFields(settings, login) {
    var response = await hostAction(settings, "fetch", {
        storeId: login.store.id,
        file: login.login + ".gpg"
    });
    if (response.status != "ok") {
        throw new Error(JSON.stringify(response)); // TODO handle host error
    }

    // save raw data inside login
    login.raw = response.data.contents;

    // parse lines
    login.fields = {
        secret: ["secret", "password", "pass"],
        login: ["login", "username", "user"],
        openid: ["openid"],
        otp: ["otp", "totp", "hotp"],
        url: ["url", "uri", "website", "site", "link", "launch"]
    };
    login.settings = {
        autoSubmit: { name: "autosubmit", type: "bool" }
    };
    var lines = login.raw.split(/[\r\n]+/).filter(line => line.trim().length > 0);
    lines.forEach(function(line) {
        // check for uri-encoded otp
        if (line.match(/^otpauth:\/\/.+/)) {
            login.fields.otp = { key: null, data: line };
            return;
        }

        // split key / value & ignore non-k/v lines
        var parts = line.match(/^(.+?):(.+)$/);
        if (parts === null) {
            return;
        }
        parts = parts
            .slice(1)
            .map(value => value.trim())
            .filter(value => value.length);
        if (parts.length != 2) {
            return;
        }

        // assign to fields
        for (var key in login.fields) {
            if (
                Array.isArray(login.fields[key]) &&
                login.fields[key].includes(parts[0].toLowerCase())
            ) {
                if (key === "otp") {
                    login.fields[key] = { key: parts[0].toLowerCase(), data: parts[1] };
                } else {
                    login.fields[key] = parts[1];
                }
                break;
            }
        }

        // assign to settings
        for (var key in login.settings) {
            if (
                typeof login.settings[key].type !== "undefined" &&
                login.settings[key].name === parts[0].toLowerCase()
            ) {
                if (login.settings[key].type === "bool") {
                    login.settings[key] = ["true", "yes"].includes(parts[1].toLowerCase());
                } else {
                    login.settings[key] = parts[1];
                }

                break;
            }
        }
    });

    // clean up unassigned fields
    for (var key in login.fields) {
        if (Array.isArray(login.fields[key])) {
            if (key === "secret" && lines.length) {
                login.fields.secret = lines[0];
            } else if (key === "login") {
                const defaultUsername = getSetting("username", login, settings);
                login.fields[key] = defaultUsername || login.login.match(/([^\/]+)$/)[1];
            } else {
                delete login.fields[key];
            }
        }
    }
    for (var key in login.settings) {
        if (typeof login.settings[key].type !== "undefined") {
            delete login.settings[key];
        }
    }
}

/**
 * Wrap inbound messages to fetch native configuration
 *
 * @since 3.0.0
 *
 * @param mixed            message      Incoming message
 * @param MessageSender    sender       Message sender
 * @param function(mixed)  sendResponse Callback to send response
 * @return void
 */
async function receiveMessage(message, sender, sendResponse) {
    // restrict messages to this extension only
    if (sender.id !== chrome.runtime.id) {
        // silently exit without responding when the source is foreign
        return;
    }

    try {
        const settings = await getFullSettings();
        handleMessage(settings, message, sendResponse);
    } catch (e) {
        // handle error
        console.log(e);
        sendResponse({ status: "error", message: e.toString() });
    }
}

/**
 * Clear usage data
 *
 * @since 3.0.10
 *
 * @return void
 */
async function clearUsageData() {
    // clear local storage
    localStorage.removeItem("foreignFills");
    localStorage.removeItem("recent");
    Object.keys(localStorage).forEach(key => {
        if (key.startsWith("recent:")) {
            localStorage.removeItem(key);
        }
    });

    // clear Indexed DB
    await idb.deleteDB("browserpass");
}

/**
 * Save settings if they are valid
 *
 * @since 3.0.0
 *
 * @param object Final settings object
 * @return void
 */
async function saveSettings(settings) {
    let settingsToSave = deepCopy(settings);

    // 'default' is our reserved name for the default store
    delete settingsToSave.stores.default;

    // verify that the native host is happy with the provided settings
    var response = await hostAction(settingsToSave, "configure");
    if (response.status != "ok") {
        throw new Error(`${response.params.message}: ${response.params.error}`);
    }

    // before save, make sure to remove store settings that we receive from the host app
    if (typeof settingsToSave.stores === "object") {
        for (var store in settingsToSave.stores) {
            delete settingsToSave.stores[store].settings;
        }
    }

    for (var key in defaultSettings) {
        if (settingsToSave.hasOwnProperty(key)) {
            localStorage.setItem(key, JSON.stringify(settingsToSave[key]));
        }
    }
}

/**
 * Trigger OTP extension (browserpass-otp)
 *
 * @since 3.0.13
 *
 * @param object settings Settings object
 * @param string action   Browserpass action
 * @param object otp      OTP field data
 * @return void
 */
function triggerOTPExtension(settings, action, otp) {
    // trigger otp extension
    for (let targetID of otpID) {
        chrome.runtime
            .sendMessage(targetID, {
                version: chrome.runtime.getManifest().version,
                action: action,
                otp: otp,
                settings: {
                    host: settings.host,
                    origin: settings.origin,
                    tab: settings.tab
                }
            })
            // Both response & error are noop functions, because we don't care about
            // the response, and if there's an error it just means the otp extension
            // is probably not installed. We can't detect that without requesting the
            // management permission, so this is an acceptable workaround.
            .then(noop => null, noop => null);
    }
}

/**
 * Handle browser extension installation and updates
 *
 * @since 3.0.0
 *
 * @param object Event details
 * @return void
 */
function onExtensionInstalled(details) {
    // No permissions
    if (!chrome.notifications) {
        return;
    }

    var show = (id, title, message) => {
        chrome.notifications.create(id, {
            title: title,
            message: message,
            iconUrl: "icon.png",
            type: "basic"
        });
    };

    if (details.reason === "install") {
        if (localStorage.getItem("installed") === null) {
            localStorage.setItem("installed", Date.now());
            show(
                "installed",
                "browserpass: Install native host app",
                "Remember to install the complementary native host app to use this extension.\n" +
                    "Instructions here: https://github.com/browserpass/browserpass-native"
            );
        }
    } else if (details.reason === "update") {
        var changelog = {
            3002000: "New permissions added to clear copied credentials after 60 seconds.",
            3000000:
                "New major update is out, please update the native host app to v3.\n" +
                "Instructions here: https://github.com/browserpass/browserpass-native"
        };

        var parseVersion = version => {
            var [major, minor, patch] = version.split(".");
            return parseInt(major) * 1000000 + parseInt(minor) * 1000 + parseInt(patch);
        };
        var newVersion = parseVersion(chrome.runtime.getManifest().version);
        var prevVersion = parseVersion(details.previousVersion);

        Object.keys(changelog)
            .sort()
            .forEach(function(version) {
                if (prevVersion < version && newVersion >= version) {
                    show(version.toString(), "browserpass: Important changes", changelog[version]);
                }
            });
    }
}

},{"./helpers":2,"@browserpass/url":3,"chrome-extension-async":8,"idb":12,"sha1":17}],2:[function(require,module,exports){
//------------------------------------- Initialisation --------------------------------------//
"use strict";

const FuzzySort = require("fuzzysort");
const sha1 = require("sha1");
const ignore = require("ignore");
const BrowserpassURL = require("@browserpass/url");

module.exports = {
    prepareLogins,
    filterSortLogins,
    ignoreFiles
};

//----------------------------------- Function definitions ----------------------------------//

/**
 * Get the deepest available domain component of a path
 *
 * @since 3.2.3
 *
 * @param string path        Path to parse
 * @param object currentHost Current host info for the active tab
 * @return object|null Extracted domain info
 */
function pathToInfo(path, currentHost) {
    var parts = path.split(/\//).reverse();
    for (var key in parts) {
        if (parts[key].indexOf("@") >= 0) {
            continue;
        }
        var info = BrowserpassURL.parseHost(parts[key]);

        // Part is considered to be a domain component in one of the following cases:
        // - it is a valid domain with well-known TLD (github.com, login.github.com)
        // - it is or isn't a valid domain with any TLD but the current host matches it EXACTLY (localhost, pi.hole)
        // - it is or isn't a valid domain with any TLD but the current host is its subdomain (login.pi.hole)
        if (
            info.validDomain ||
            currentHost.hostname === info.hostname ||
            currentHost.hostname.endsWith(`.${info.hostname}`)
        ) {
            return info;
        }
    }

    return null;
}

/**
 * Prepare list of logins based on provided files
 *
 * @since 3.1.0
 *
 * @param string array  List of password files
 * @param string object Settings object
 * @return array List of logins
 */
function prepareLogins(files, settings) {
    const logins = [];
    let index = 0;
    let origin = new BrowserpassURL(settings.origin);

    for (let storeId in files) {
        for (let key in files[storeId]) {
            // set login fields
            const login = {
                index: index++,
                store: settings.stores[storeId],
                login: files[storeId][key].replace(/\.gpg$/i, ""),
                allowFill: true
            };

            // extract url info from path
            let pathInfo = pathToInfo(storeId + "/" + login.login, origin);
            if (pathInfo) {
                // set assumed host
                login.host = pathInfo.port
                    ? `${pathInfo.hostname}:${pathInfo.port}`
                    : pathInfo.hostname;

                // check whether extracted path info matches the current origin
                login.inCurrentHost = origin.hostname === pathInfo.hostname;

                // check whether the current origin is subordinate to extracted path info, meaning:
                //  - that the path info is not a single level domain (e.g. com, net, local)
                //  - and that the current origin is a subdomain of that path info
                if (
                    pathInfo.hostname.includes(".") &&
                    origin.hostname.endsWith(`.${pathInfo.hostname}`)
                ) {
                    login.inCurrentHost = true;
                }

                // filter out entries with a non-matching port
                if (pathInfo.port && pathInfo.port !== origin.port) {
                    login.inCurrentHost = false;
                }
            } else {
                login.host = null;
                login.inCurrentHost = false;
            }

            // update recent counter
            login.recent =
                settings.recent[sha1(settings.origin + sha1(login.store.id + sha1(login.login)))];
            if (!login.recent) {
                login.recent = {
                    when: 0,
                    count: 0
                };
            }

            logins.push(login);
        }
    }

    return logins;
}

/**
 * Filter and sort logins
 *
 * @since 3.1.0
 *
 * @param string array  List of logins
 * @param string object Settings object
 * @return array Filtered and sorted list of logins
 */
function filterSortLogins(logins, searchQuery, currentDomainOnly) {
    var fuzzyFirstWord = searchQuery.substr(0, 1) !== " ";
    searchQuery = searchQuery.trim();

    // get candidate list
    var candidates = logins.map(candidate => {
        let lastSlashIndex = candidate.login.lastIndexOf("/") + 1;
        return Object.assign(candidate, {
            path: candidate.login.substr(0, lastSlashIndex),
            display: candidate.login.substr(lastSlashIndex)
        });
    });

    var mostRecent = null;
    if (currentDomainOnly) {
        var recent = candidates.filter(function(login) {
            if (login.recent.count > 0) {
                // find most recently used login
                if (!mostRecent || login.recent.when > mostRecent.recent.when) {
                    mostRecent = login;
                }
                return true;
            }
            return false;
        });
        var remainingInCurrentDomain = candidates.filter(
            login => login.inCurrentHost && !login.recent.count
        );
        candidates = recent.concat(remainingInCurrentDomain);
    }

    candidates.sort((a, b) => {
        // show most recent first
        if (a === mostRecent) {
            return -1;
        }
        if (b === mostRecent) {
            return 1;
        }

        // sort by frequency
        var countDiff = b.recent.count - a.recent.count;
        if (countDiff) {
            return countDiff;
        }

        // sort by specificity, only if filtering for one domain
        if (currentDomainOnly) {
            var domainLevelsDiff =
                (b.login.match(/\./g) || []).length - (a.login.match(/\./g) || []).length;
            if (domainLevelsDiff) {
                return domainLevelsDiff;
            }
        }

        // sort alphabetically
        return a.login.localeCompare(b.login);
    });

    if (searchQuery.length) {
        let filter = searchQuery.split(/\s+/);
        let fuzzyFilter = fuzzyFirstWord ? filter[0] : "";
        let substringFilters = filter.slice(fuzzyFirstWord ? 1 : 0).map(w => w.toLowerCase());

        // First reduce the list by running the substring search
        substringFilters.forEach(function(word) {
            candidates = candidates.filter(c => c.login.toLowerCase().indexOf(word) >= 0);
        });

        // Then run the fuzzy filter
        let fuzzyResults = {};
        if (fuzzyFilter) {
            candidates = FuzzySort.go(fuzzyFilter, candidates, {
                keys: ["login", "store.name"],
                allowTypo: false
            }).map(result => {
                fuzzyResults[result.obj.login] = result;
                return result.obj;
            });
        }

        // Finally highlight all matches
        candidates = candidates.map(c => highlightMatches(c, fuzzyResults, substringFilters));
    }

    // Prefix root entries with slash to let them have some visible path
    candidates.forEach(c => {
        c.path = c.path || "/";
    });

    return candidates;
}

//----------------------------------- Private functions ----------------------------------//

/**
 * Highlight filter matches
 *
 * @since 3.0.0
 *
 * @param object entry password entry
 * @param object fuzzyResults positions of fuzzy filter matches
 * @param array substringFilters list of substring filters applied
 * @return object entry with highlighted matches
 */
function highlightMatches(entry, fuzzyResults, substringFilters) {
    // Add all positions of the fuzzy search to the array
    let matches = (fuzzyResults[entry.login] && fuzzyResults[entry.login][0]
        ? fuzzyResults[entry.login][0].indexes
        : []
    ).slice();

    // Add all positions of substring searches to the array
    let login = entry.login.toLowerCase();
    for (let word of substringFilters) {
        let startIndex = login.indexOf(word);
        for (let i = 0; i < word.length; i++) {
            matches.push(startIndex + i);
        }
    }

    // Prepare the final array of matches before
    matches = sortUnique(matches, (a, b) => a - b);

    const OPEN = "<em>";
    const CLOSE = "</em>";
    let highlighted = "";
    var matchesIndex = 0;
    var opened = false;
    for (var i = 0; i < entry.login.length; ++i) {
        var char = entry.login[i];

        if (i == entry.path.length) {
            if (opened) {
                highlighted += CLOSE;
            }
            var path = highlighted;
            highlighted = "";
            if (opened) {
                highlighted += OPEN;
            }
        }

        if (matches[matchesIndex] === i) {
            matchesIndex++;
            if (!opened) {
                opened = true;
                highlighted += OPEN;
            }
        } else {
            if (opened) {
                opened = false;
                highlighted += CLOSE;
            }
        }
        highlighted += char;
    }
    if (opened) {
        opened = false;
        highlighted += CLOSE;
    }
    let display = highlighted;

    return Object.assign(entry, {
        path: path,
        display: display
    });
}

/**
 * Filter out ignored files according to .browserpass.json rules
 *
 * @since 3.2.0
 *
 * @param object files    Arrays of files, grouped by store
 * @param object settings Settings object
 * @return object Filtered arrays of files, grouped by store
 */
function ignoreFiles(files, settings) {
    let filteredFiles = {};
    for (let store in files) {
        let storeSettings = settings.stores[store].settings;
        if (storeSettings.hasOwnProperty("ignore")) {
            if (typeof storeSettings.ignore === "string") {
                storeSettings.ignore = [storeSettings.ignore];
            }
            filteredFiles[store] = ignore()
                .add(storeSettings.ignore)
                .filter(files[store]);
        } else {
            filteredFiles[store] = files[store];
        }
    }
    return filteredFiles;
}

/**
 * Sort and remove duplicates
 *
 * @since 3.0.0
 *
 * @param array array items to sort
 * @param function comparator sort comparator
 * @return array sorted items without duplicates
 */
function sortUnique(array, comparator) {
    return array
        .sort(comparator)
        .filter((elem, index, arr) => index == !arr.length || arr[index - 1] != elem);
}

},{"@browserpass/url":3,"fuzzysort":10,"ignore":14,"sha1":17}],3:[function(require,module,exports){
"use strict";

const punycode = require("punycode");
const { tldList } = require("./tld.js");

// protocol -> port mapping
const portMap = {
    http: 80,
    https: 443
}

/**
 * Enhanced URL class
 */
module.exports = class extends URL {
    /**
     * Constructor
     *
     * @param string url URL to parse
     * @param string base Base URL
     */
    constructor(url, base) {
        super(url, base);

        // if no port is defined, but the protocol port is known, set the port to that
        let rawProtocol = this.protocol.substring(0, this.protocol.length - 1);
        if (!this.port && rawProtocol in portMap) {
            Object.defineProperty(this, "port", {
                value: portMap[rawProtocol].toString(10),
                writable: false,
                enumerable: true
            });
        }

        // set domain components
        let components = getComponents(this.hostname);
        for (let key in components) {
            Object.defineProperty(this, key, {
                value: components[key],
                writable: false,
                enumerable: true
            });
        }
    }

    /**
     * Parse a hostname (with optional port) only, rather than a full URL
     *
     * @param string hostname Hostname
     * @return object Domain information
     */
    static parseHost(hostname) {
        let matches = hostname.match(/(.*?)(?::([0-9]+))?$/);
        let components = getComponents(matches[1]);
        components.port = matches[2] || null;

        return components;
    }
};

/**
 * Check whether the provided hostname is a TLD
 *
 * @param string hostname Hostname to check
 * @return boolean
 */
function isTLD(hostname) {
    hostname = punycode.toUnicode(hostname);
    let isTLD = tldList.includes(hostname);
    if (!isTLD) {
        isTLD = tldList.includes(`*.${hostname}`);
        if (isTLD && tldList.includes(`!${hostname}`)) {
            isTLD = false;
        }
    }
    return isTLD;
}

/**
 * Get the components for a hostname
 *
 * @param string hostname Hostname
 */
function getComponents(hostname) {
    let components = {
        hostname,
        tld: null,
        domain: null,
        subdomain: null,
        validDomain: false
    };
    let parts = hostname.split(/\./);
    for (let i = 0; i < parts.length; i++) {
        let checkTLD = parts.slice(i).join(".");
        if (isTLD(checkTLD)) {
            components.tld = checkTLD;
            if (i > 0) {
                components.validDomain = true;
                components.domain = parts.slice(i - 1).join(".");
                components.subdomain = parts.slice(0, i - 1).join(".");
            }
            break;
        }
    }

    return components;
}

},{"./tld.js":4,"punycode":16}],4:[function(require,module,exports){
"use strict";

const tldList = [
    "ac",
    "com.ac",
    "edu.ac",
    "gov.ac",
    "net.ac",
    "mil.ac",
    "org.ac",
    "ad",
    "nom.ad",
    "ae",
    "co.ae",
    "net.ae",
    "org.ae",
    "sch.ae",
    "ac.ae",
    "gov.ae",
    "mil.ae",
    "aero",
    "accident-investigation.aero",
    "accident-prevention.aero",
    "aerobatic.aero",
    "aeroclub.aero",
    "aerodrome.aero",
    "agents.aero",
    "aircraft.aero",
    "airline.aero",
    "airport.aero",
    "air-surveillance.aero",
    "airtraffic.aero",
    "air-traffic-control.aero",
    "ambulance.aero",
    "amusement.aero",
    "association.aero",
    "author.aero",
    "ballooning.aero",
    "broker.aero",
    "caa.aero",
    "cargo.aero",
    "catering.aero",
    "certification.aero",
    "championship.aero",
    "charter.aero",
    "civilaviation.aero",
    "club.aero",
    "conference.aero",
    "consultant.aero",
    "consulting.aero",
    "control.aero",
    "council.aero",
    "crew.aero",
    "design.aero",
    "dgca.aero",
    "educator.aero",
    "emergency.aero",
    "engine.aero",
    "engineer.aero",
    "entertainment.aero",
    "equipment.aero",
    "exchange.aero",
    "express.aero",
    "federation.aero",
    "flight.aero",
    "freight.aero",
    "fuel.aero",
    "gliding.aero",
    "government.aero",
    "groundhandling.aero",
    "group.aero",
    "hanggliding.aero",
    "homebuilt.aero",
    "insurance.aero",
    "journal.aero",
    "journalist.aero",
    "leasing.aero",
    "logistics.aero",
    "magazine.aero",
    "maintenance.aero",
    "media.aero",
    "microlight.aero",
    "modelling.aero",
    "navigation.aero",
    "parachuting.aero",
    "paragliding.aero",
    "passenger-association.aero",
    "pilot.aero",
    "press.aero",
    "production.aero",
    "recreation.aero",
    "repbody.aero",
    "res.aero",
    "research.aero",
    "rotorcraft.aero",
    "safety.aero",
    "scientist.aero",
    "services.aero",
    "show.aero",
    "skydiving.aero",
    "software.aero",
    "student.aero",
    "trader.aero",
    "trading.aero",
    "trainer.aero",
    "union.aero",
    "workinggroup.aero",
    "works.aero",
    "af",
    "gov.af",
    "com.af",
    "org.af",
    "net.af",
    "edu.af",
    "ag",
    "com.ag",
    "org.ag",
    "net.ag",
    "co.ag",
    "nom.ag",
    "ai",
    "off.ai",
    "com.ai",
    "net.ai",
    "org.ai",
    "al",
    "com.al",
    "edu.al",
    "gov.al",
    "mil.al",
    "net.al",
    "org.al",
    "am",
    "co.am",
    "com.am",
    "commune.am",
    "net.am",
    "org.am",
    "ao",
    "ed.ao",
    "gv.ao",
    "og.ao",
    "co.ao",
    "pb.ao",
    "it.ao",
    "aq",
    "ar",
    "com.ar",
    "edu.ar",
    "gob.ar",
    "gov.ar",
    "int.ar",
    "mil.ar",
    "musica.ar",
    "net.ar",
    "org.ar",
    "tur.ar",
    "arpa",
    "e164.arpa",
    "in-addr.arpa",
    "ip6.arpa",
    "iris.arpa",
    "uri.arpa",
    "urn.arpa",
    "as",
    "gov.as",
    "asia",
    "at",
    "ac.at",
    "co.at",
    "gv.at",
    "or.at",
    "au",
    "com.au",
    "net.au",
    "org.au",
    "edu.au",
    "gov.au",
    "asn.au",
    "id.au",
    "info.au",
    "conf.au",
    "oz.au",
    "act.au",
    "nsw.au",
    "nt.au",
    "qld.au",
    "sa.au",
    "tas.au",
    "vic.au",
    "wa.au",
    "act.edu.au",
    "catholic.edu.au",
    "eq.edu.au",
    "nsw.edu.au",
    "nt.edu.au",
    "qld.edu.au",
    "sa.edu.au",
    "tas.edu.au",
    "vic.edu.au",
    "wa.edu.au",
    "qld.gov.au",
    "sa.gov.au",
    "tas.gov.au",
    "vic.gov.au",
    "wa.gov.au",
    "education.tas.edu.au",
    "schools.nsw.edu.au",
    "aw",
    "com.aw",
    "ax",
    "az",
    "com.az",
    "net.az",
    "int.az",
    "gov.az",
    "org.az",
    "edu.az",
    "info.az",
    "pp.az",
    "mil.az",
    "name.az",
    "pro.az",
    "biz.az",
    "ba",
    "com.ba",
    "edu.ba",
    "gov.ba",
    "mil.ba",
    "net.ba",
    "org.ba",
    "bb",
    "biz.bb",
    "co.bb",
    "com.bb",
    "edu.bb",
    "gov.bb",
    "info.bb",
    "net.bb",
    "org.bb",
    "store.bb",
    "tv.bb",
    "*.bd",
    "be",
    "ac.be",
    "bf",
    "gov.bf",
    "bg",
    "a.bg",
    "b.bg",
    "c.bg",
    "d.bg",
    "e.bg",
    "f.bg",
    "g.bg",
    "h.bg",
    "i.bg",
    "j.bg",
    "k.bg",
    "l.bg",
    "m.bg",
    "n.bg",
    "o.bg",
    "p.bg",
    "q.bg",
    "r.bg",
    "s.bg",
    "t.bg",
    "u.bg",
    "v.bg",
    "w.bg",
    "x.bg",
    "y.bg",
    "z.bg",
    "0.bg",
    "1.bg",
    "2.bg",
    "3.bg",
    "4.bg",
    "5.bg",
    "6.bg",
    "7.bg",
    "8.bg",
    "9.bg",
    "bh",
    "com.bh",
    "edu.bh",
    "net.bh",
    "org.bh",
    "gov.bh",
    "bi",
    "co.bi",
    "com.bi",
    "edu.bi",
    "or.bi",
    "org.bi",
    "biz",
    "bj",
    "asso.bj",
    "barreau.bj",
    "gouv.bj",
    "bm",
    "com.bm",
    "edu.bm",
    "gov.bm",
    "net.bm",
    "org.bm",
    "bn",
    "com.bn",
    "edu.bn",
    "gov.bn",
    "net.bn",
    "org.bn",
    "bo",
    "com.bo",
    "edu.bo",
    "gob.bo",
    "int.bo",
    "org.bo",
    "net.bo",
    "mil.bo",
    "tv.bo",
    "web.bo",
    "academia.bo",
    "agro.bo",
    "arte.bo",
    "blog.bo",
    "bolivia.bo",
    "ciencia.bo",
    "cooperativa.bo",
    "democracia.bo",
    "deporte.bo",
    "ecologia.bo",
    "economia.bo",
    "empresa.bo",
    "indigena.bo",
    "industria.bo",
    "info.bo",
    "medicina.bo",
    "movimiento.bo",
    "musica.bo",
    "natural.bo",
    "nombre.bo",
    "noticias.bo",
    "patria.bo",
    "politica.bo",
    "profesional.bo",
    "plurinacional.bo",
    "pueblo.bo",
    "revista.bo",
    "salud.bo",
    "tecnologia.bo",
    "tksat.bo",
    "transporte.bo",
    "wiki.bo",
    "br",
    "9guacu.br",
    "abc.br",
    "adm.br",
    "adv.br",
    "agr.br",
    "aju.br",
    "am.br",
    "anani.br",
    "aparecida.br",
    "arq.br",
    "art.br",
    "ato.br",
    "b.br",
    "barueri.br",
    "belem.br",
    "bhz.br",
    "bio.br",
    "blog.br",
    "bmd.br",
    "boavista.br",
    "bsb.br",
    "campinagrande.br",
    "campinas.br",
    "caxias.br",
    "cim.br",
    "cng.br",
    "cnt.br",
    "com.br",
    "contagem.br",
    "coop.br",
    "cri.br",
    "cuiaba.br",
    "curitiba.br",
    "def.br",
    "ecn.br",
    "eco.br",
    "edu.br",
    "emp.br",
    "eng.br",
    "esp.br",
    "etc.br",
    "eti.br",
    "far.br",
    "feira.br",
    "flog.br",
    "floripa.br",
    "fm.br",
    "fnd.br",
    "fortal.br",
    "fot.br",
    "foz.br",
    "fst.br",
    "g12.br",
    "ggf.br",
    "goiania.br",
    "gov.br",
    "ac.gov.br",
    "al.gov.br",
    "am.gov.br",
    "ap.gov.br",
    "ba.gov.br",
    "ce.gov.br",
    "df.gov.br",
    "es.gov.br",
    "go.gov.br",
    "ma.gov.br",
    "mg.gov.br",
    "ms.gov.br",
    "mt.gov.br",
    "pa.gov.br",
    "pb.gov.br",
    "pe.gov.br",
    "pi.gov.br",
    "pr.gov.br",
    "rj.gov.br",
    "rn.gov.br",
    "ro.gov.br",
    "rr.gov.br",
    "rs.gov.br",
    "sc.gov.br",
    "se.gov.br",
    "sp.gov.br",
    "to.gov.br",
    "gru.br",
    "imb.br",
    "ind.br",
    "inf.br",
    "jab.br",
    "jampa.br",
    "jdf.br",
    "joinville.br",
    "jor.br",
    "jus.br",
    "leg.br",
    "lel.br",
    "londrina.br",
    "macapa.br",
    "maceio.br",
    "manaus.br",
    "maringa.br",
    "mat.br",
    "med.br",
    "mil.br",
    "morena.br",
    "mp.br",
    "mus.br",
    "natal.br",
    "net.br",
    "niteroi.br",
    "*.nom.br",
    "not.br",
    "ntr.br",
    "odo.br",
    "ong.br",
    "org.br",
    "osasco.br",
    "palmas.br",
    "poa.br",
    "ppg.br",
    "pro.br",
    "psc.br",
    "psi.br",
    "pvh.br",
    "qsl.br",
    "radio.br",
    "rec.br",
    "recife.br",
    "ribeirao.br",
    "rio.br",
    "riobranco.br",
    "riopreto.br",
    "salvador.br",
    "sampa.br",
    "santamaria.br",
    "santoandre.br",
    "saobernardo.br",
    "saogonca.br",
    "sjc.br",
    "slg.br",
    "slz.br",
    "sorocaba.br",
    "srv.br",
    "taxi.br",
    "tc.br",
    "teo.br",
    "the.br",
    "tmp.br",
    "trd.br",
    "tur.br",
    "tv.br",
    "udi.br",
    "vet.br",
    "vix.br",
    "vlog.br",
    "wiki.br",
    "zlg.br",
    "bs",
    "com.bs",
    "net.bs",
    "org.bs",
    "edu.bs",
    "gov.bs",
    "bt",
    "com.bt",
    "edu.bt",
    "gov.bt",
    "net.bt",
    "org.bt",
    "bv",
    "bw",
    "co.bw",
    "org.bw",
    "by",
    "gov.by",
    "mil.by",
    "com.by",
    "of.by",
    "bz",
    "com.bz",
    "net.bz",
    "org.bz",
    "edu.bz",
    "gov.bz",
    "ca",
    "ab.ca",
    "bc.ca",
    "mb.ca",
    "nb.ca",
    "nf.ca",
    "nl.ca",
    "ns.ca",
    "nt.ca",
    "nu.ca",
    "on.ca",
    "pe.ca",
    "qc.ca",
    "sk.ca",
    "yk.ca",
    "gc.ca",
    "cat",
    "cc",
    "cd",
    "gov.cd",
    "cf",
    "cg",
    "ch",
    "ci",
    "org.ci",
    "or.ci",
    "com.ci",
    "co.ci",
    "edu.ci",
    "ed.ci",
    "ac.ci",
    "net.ci",
    "go.ci",
    "asso.ci",
    "aéroport.ci",
    "int.ci",
    "presse.ci",
    "md.ci",
    "gouv.ci",
    "*.ck",
    "!www.ck",
    "cl",
    "gov.cl",
    "gob.cl",
    "co.cl",
    "mil.cl",
    "cm",
    "co.cm",
    "com.cm",
    "gov.cm",
    "net.cm",
    "cn",
    "ac.cn",
    "com.cn",
    "edu.cn",
    "gov.cn",
    "net.cn",
    "org.cn",
    "mil.cn",
    "公司.cn",
    "网络.cn",
    "網絡.cn",
    "ah.cn",
    "bj.cn",
    "cq.cn",
    "fj.cn",
    "gd.cn",
    "gs.cn",
    "gz.cn",
    "gx.cn",
    "ha.cn",
    "hb.cn",
    "he.cn",
    "hi.cn",
    "hl.cn",
    "hn.cn",
    "jl.cn",
    "js.cn",
    "jx.cn",
    "ln.cn",
    "nm.cn",
    "nx.cn",
    "qh.cn",
    "sc.cn",
    "sd.cn",
    "sh.cn",
    "sn.cn",
    "sx.cn",
    "tj.cn",
    "xj.cn",
    "xz.cn",
    "yn.cn",
    "zj.cn",
    "hk.cn",
    "mo.cn",
    "tw.cn",
    "co",
    "arts.co",
    "com.co",
    "edu.co",
    "firm.co",
    "gov.co",
    "info.co",
    "int.co",
    "mil.co",
    "net.co",
    "nom.co",
    "org.co",
    "rec.co",
    "web.co",
    "com",
    "coop",
    "cr",
    "ac.cr",
    "co.cr",
    "ed.cr",
    "fi.cr",
    "go.cr",
    "or.cr",
    "sa.cr",
    "cu",
    "com.cu",
    "edu.cu",
    "org.cu",
    "net.cu",
    "gov.cu",
    "inf.cu",
    "cv",
    "cw",
    "com.cw",
    "edu.cw",
    "net.cw",
    "org.cw",
    "cx",
    "gov.cx",
    "cy",
    "ac.cy",
    "biz.cy",
    "com.cy",
    "ekloges.cy",
    "gov.cy",
    "ltd.cy",
    "name.cy",
    "net.cy",
    "org.cy",
    "parliament.cy",
    "press.cy",
    "pro.cy",
    "tm.cy",
    "cz",
    "de",
    "dj",
    "dk",
    "dm",
    "com.dm",
    "net.dm",
    "org.dm",
    "edu.dm",
    "gov.dm",
    "do",
    "art.do",
    "com.do",
    "edu.do",
    "gob.do",
    "gov.do",
    "mil.do",
    "net.do",
    "org.do",
    "sld.do",
    "web.do",
    "dz",
    "com.dz",
    "org.dz",
    "net.dz",
    "gov.dz",
    "edu.dz",
    "asso.dz",
    "pol.dz",
    "art.dz",
    "ec",
    "com.ec",
    "info.ec",
    "net.ec",
    "fin.ec",
    "k12.ec",
    "med.ec",
    "pro.ec",
    "org.ec",
    "edu.ec",
    "gov.ec",
    "gob.ec",
    "mil.ec",
    "edu",
    "ee",
    "edu.ee",
    "gov.ee",
    "riik.ee",
    "lib.ee",
    "med.ee",
    "com.ee",
    "pri.ee",
    "aip.ee",
    "org.ee",
    "fie.ee",
    "eg",
    "com.eg",
    "edu.eg",
    "eun.eg",
    "gov.eg",
    "mil.eg",
    "name.eg",
    "net.eg",
    "org.eg",
    "sci.eg",
    "*.er",
    "es",
    "com.es",
    "nom.es",
    "org.es",
    "gob.es",
    "edu.es",
    "et",
    "com.et",
    "gov.et",
    "org.et",
    "edu.et",
    "biz.et",
    "name.et",
    "info.et",
    "net.et",
    "eu",
    "fi",
    "aland.fi",
    "*.fj",
    "*.fk",
    "fm",
    "fo",
    "fr",
    "asso.fr",
    "com.fr",
    "gouv.fr",
    "nom.fr",
    "prd.fr",
    "tm.fr",
    "aeroport.fr",
    "avocat.fr",
    "avoues.fr",
    "cci.fr",
    "chambagri.fr",
    "chirurgiens-dentistes.fr",
    "experts-comptables.fr",
    "geometre-expert.fr",
    "greta.fr",
    "huissier-justice.fr",
    "medecin.fr",
    "notaires.fr",
    "pharmacien.fr",
    "port.fr",
    "veterinaire.fr",
    "ga",
    "gb",
    "gd",
    "ge",
    "com.ge",
    "edu.ge",
    "gov.ge",
    "org.ge",
    "mil.ge",
    "net.ge",
    "pvt.ge",
    "gf",
    "gg",
    "co.gg",
    "net.gg",
    "org.gg",
    "gh",
    "com.gh",
    "edu.gh",
    "gov.gh",
    "org.gh",
    "mil.gh",
    "gi",
    "com.gi",
    "ltd.gi",
    "gov.gi",
    "mod.gi",
    "edu.gi",
    "org.gi",
    "gl",
    "co.gl",
    "com.gl",
    "edu.gl",
    "net.gl",
    "org.gl",
    "gm",
    "gn",
    "ac.gn",
    "com.gn",
    "edu.gn",
    "gov.gn",
    "org.gn",
    "net.gn",
    "gov",
    "gp",
    "com.gp",
    "net.gp",
    "mobi.gp",
    "edu.gp",
    "org.gp",
    "asso.gp",
    "gq",
    "gr",
    "com.gr",
    "edu.gr",
    "net.gr",
    "org.gr",
    "gov.gr",
    "gs",
    "gt",
    "com.gt",
    "edu.gt",
    "gob.gt",
    "ind.gt",
    "mil.gt",
    "net.gt",
    "org.gt",
    "gu",
    "com.gu",
    "edu.gu",
    "gov.gu",
    "guam.gu",
    "info.gu",
    "net.gu",
    "org.gu",
    "web.gu",
    "gw",
    "gy",
    "co.gy",
    "com.gy",
    "edu.gy",
    "gov.gy",
    "net.gy",
    "org.gy",
    "hk",
    "com.hk",
    "edu.hk",
    "gov.hk",
    "idv.hk",
    "net.hk",
    "org.hk",
    "公司.hk",
    "教育.hk",
    "敎育.hk",
    "政府.hk",
    "個人.hk",
    "个人.hk",
    "箇人.hk",
    "網络.hk",
    "网络.hk",
    "组織.hk",
    "網絡.hk",
    "网絡.hk",
    "组织.hk",
    "組織.hk",
    "組织.hk",
    "hm",
    "hn",
    "com.hn",
    "edu.hn",
    "org.hn",
    "net.hn",
    "mil.hn",
    "gob.hn",
    "hr",
    "iz.hr",
    "from.hr",
    "name.hr",
    "com.hr",
    "ht",
    "com.ht",
    "shop.ht",
    "firm.ht",
    "info.ht",
    "adult.ht",
    "net.ht",
    "pro.ht",
    "org.ht",
    "med.ht",
    "art.ht",
    "coop.ht",
    "pol.ht",
    "asso.ht",
    "edu.ht",
    "rel.ht",
    "gouv.ht",
    "perso.ht",
    "hu",
    "co.hu",
    "info.hu",
    "org.hu",
    "priv.hu",
    "sport.hu",
    "tm.hu",
    "2000.hu",
    "agrar.hu",
    "bolt.hu",
    "casino.hu",
    "city.hu",
    "erotica.hu",
    "erotika.hu",
    "film.hu",
    "forum.hu",
    "games.hu",
    "hotel.hu",
    "ingatlan.hu",
    "jogasz.hu",
    "konyvelo.hu",
    "lakas.hu",
    "media.hu",
    "news.hu",
    "reklam.hu",
    "sex.hu",
    "shop.hu",
    "suli.hu",
    "szex.hu",
    "tozsde.hu",
    "utazas.hu",
    "video.hu",
    "id",
    "ac.id",
    "biz.id",
    "co.id",
    "desa.id",
    "go.id",
    "mil.id",
    "my.id",
    "net.id",
    "or.id",
    "ponpes.id",
    "sch.id",
    "web.id",
    "ie",
    "gov.ie",
    "il",
    "ac.il",
    "co.il",
    "gov.il",
    "idf.il",
    "k12.il",
    "muni.il",
    "net.il",
    "org.il",
    "im",
    "ac.im",
    "co.im",
    "com.im",
    "ltd.co.im",
    "net.im",
    "org.im",
    "plc.co.im",
    "tt.im",
    "tv.im",
    "in",
    "co.in",
    "firm.in",
    "net.in",
    "org.in",
    "gen.in",
    "ind.in",
    "nic.in",
    "ac.in",
    "edu.in",
    "res.in",
    "gov.in",
    "mil.in",
    "info",
    "int",
    "eu.int",
    "io",
    "com.io",
    "iq",
    "gov.iq",
    "edu.iq",
    "mil.iq",
    "com.iq",
    "org.iq",
    "net.iq",
    "ir",
    "ac.ir",
    "co.ir",
    "gov.ir",
    "id.ir",
    "net.ir",
    "org.ir",
    "sch.ir",
    "ایران.ir",
    "ايران.ir",
    "is",
    "net.is",
    "com.is",
    "edu.is",
    "gov.is",
    "org.is",
    "int.is",
    "it",
    "gov.it",
    "edu.it",
    "abr.it",
    "abruzzo.it",
    "aosta-valley.it",
    "aostavalley.it",
    "bas.it",
    "basilicata.it",
    "cal.it",
    "calabria.it",
    "cam.it",
    "campania.it",
    "emilia-romagna.it",
    "emiliaromagna.it",
    "emr.it",
    "friuli-v-giulia.it",
    "friuli-ve-giulia.it",
    "friuli-vegiulia.it",
    "friuli-venezia-giulia.it",
    "friuli-veneziagiulia.it",
    "friuli-vgiulia.it",
    "friuliv-giulia.it",
    "friulive-giulia.it",
    "friulivegiulia.it",
    "friulivenezia-giulia.it",
    "friuliveneziagiulia.it",
    "friulivgiulia.it",
    "fvg.it",
    "laz.it",
    "lazio.it",
    "lig.it",
    "liguria.it",
    "lom.it",
    "lombardia.it",
    "lombardy.it",
    "lucania.it",
    "mar.it",
    "marche.it",
    "mol.it",
    "molise.it",
    "piedmont.it",
    "piemonte.it",
    "pmn.it",
    "pug.it",
    "puglia.it",
    "sar.it",
    "sardegna.it",
    "sardinia.it",
    "sic.it",
    "sicilia.it",
    "sicily.it",
    "taa.it",
    "tos.it",
    "toscana.it",
    "trentin-sud-tirol.it",
    "trentin-süd-tirol.it",
    "trentin-sudtirol.it",
    "trentin-südtirol.it",
    "trentin-sued-tirol.it",
    "trentin-suedtirol.it",
    "trentino-a-adige.it",
    "trentino-aadige.it",
    "trentino-alto-adige.it",
    "trentino-altoadige.it",
    "trentino-s-tirol.it",
    "trentino-stirol.it",
    "trentino-sud-tirol.it",
    "trentino-süd-tirol.it",
    "trentino-sudtirol.it",
    "trentino-südtirol.it",
    "trentino-sued-tirol.it",
    "trentino-suedtirol.it",
    "trentino.it",
    "trentinoa-adige.it",
    "trentinoaadige.it",
    "trentinoalto-adige.it",
    "trentinoaltoadige.it",
    "trentinos-tirol.it",
    "trentinostirol.it",
    "trentinosud-tirol.it",
    "trentinosüd-tirol.it",
    "trentinosudtirol.it",
    "trentinosüdtirol.it",
    "trentinosued-tirol.it",
    "trentinosuedtirol.it",
    "trentinsud-tirol.it",
    "trentinsüd-tirol.it",
    "trentinsudtirol.it",
    "trentinsüdtirol.it",
    "trentinsued-tirol.it",
    "trentinsuedtirol.it",
    "tuscany.it",
    "umb.it",
    "umbria.it",
    "val-d-aosta.it",
    "val-daosta.it",
    "vald-aosta.it",
    "valdaosta.it",
    "valle-aosta.it",
    "valle-d-aosta.it",
    "valle-daosta.it",
    "valleaosta.it",
    "valled-aosta.it",
    "valledaosta.it",
    "vallee-aoste.it",
    "vallée-aoste.it",
    "vallee-d-aoste.it",
    "vallée-d-aoste.it",
    "valleeaoste.it",
    "valléeaoste.it",
    "valleedaoste.it",
    "valléedaoste.it",
    "vao.it",
    "vda.it",
    "ven.it",
    "veneto.it",
    "ag.it",
    "agrigento.it",
    "al.it",
    "alessandria.it",
    "alto-adige.it",
    "altoadige.it",
    "an.it",
    "ancona.it",
    "andria-barletta-trani.it",
    "andria-trani-barletta.it",
    "andriabarlettatrani.it",
    "andriatranibarletta.it",
    "ao.it",
    "aosta.it",
    "aoste.it",
    "ap.it",
    "aq.it",
    "aquila.it",
    "ar.it",
    "arezzo.it",
    "ascoli-piceno.it",
    "ascolipiceno.it",
    "asti.it",
    "at.it",
    "av.it",
    "avellino.it",
    "ba.it",
    "balsan-sudtirol.it",
    "balsan-südtirol.it",
    "balsan-suedtirol.it",
    "balsan.it",
    "bari.it",
    "barletta-trani-andria.it",
    "barlettatraniandria.it",
    "belluno.it",
    "benevento.it",
    "bergamo.it",
    "bg.it",
    "bi.it",
    "biella.it",
    "bl.it",
    "bn.it",
    "bo.it",
    "bologna.it",
    "bolzano-altoadige.it",
    "bolzano.it",
    "bozen-sudtirol.it",
    "bozen-südtirol.it",
    "bozen-suedtirol.it",
    "bozen.it",
    "br.it",
    "brescia.it",
    "brindisi.it",
    "bs.it",
    "bt.it",
    "bulsan-sudtirol.it",
    "bulsan-südtirol.it",
    "bulsan-suedtirol.it",
    "bulsan.it",
    "bz.it",
    "ca.it",
    "cagliari.it",
    "caltanissetta.it",
    "campidano-medio.it",
    "campidanomedio.it",
    "campobasso.it",
    "carbonia-iglesias.it",
    "carboniaiglesias.it",
    "carrara-massa.it",
    "carraramassa.it",
    "caserta.it",
    "catania.it",
    "catanzaro.it",
    "cb.it",
    "ce.it",
    "cesena-forli.it",
    "cesena-forlì.it",
    "cesenaforli.it",
    "cesenaforlì.it",
    "ch.it",
    "chieti.it",
    "ci.it",
    "cl.it",
    "cn.it",
    "co.it",
    "como.it",
    "cosenza.it",
    "cr.it",
    "cremona.it",
    "crotone.it",
    "cs.it",
    "ct.it",
    "cuneo.it",
    "cz.it",
    "dell-ogliastra.it",
    "dellogliastra.it",
    "en.it",
    "enna.it",
    "fc.it",
    "fe.it",
    "fermo.it",
    "ferrara.it",
    "fg.it",
    "fi.it",
    "firenze.it",
    "florence.it",
    "fm.it",
    "foggia.it",
    "forli-cesena.it",
    "forlì-cesena.it",
    "forlicesena.it",
    "forlìcesena.it",
    "fr.it",
    "frosinone.it",
    "ge.it",
    "genoa.it",
    "genova.it",
    "go.it",
    "gorizia.it",
    "gr.it",
    "grosseto.it",
    "iglesias-carbonia.it",
    "iglesiascarbonia.it",
    "im.it",
    "imperia.it",
    "is.it",
    "isernia.it",
    "kr.it",
    "la-spezia.it",
    "laquila.it",
    "laspezia.it",
    "latina.it",
    "lc.it",
    "le.it",
    "lecce.it",
    "lecco.it",
    "li.it",
    "livorno.it",
    "lo.it",
    "lodi.it",
    "lt.it",
    "lu.it",
    "lucca.it",
    "macerata.it",
    "mantova.it",
    "massa-carrara.it",
    "massacarrara.it",
    "matera.it",
    "mb.it",
    "mc.it",
    "me.it",
    "medio-campidano.it",
    "mediocampidano.it",
    "messina.it",
    "mi.it",
    "milan.it",
    "milano.it",
    "mn.it",
    "mo.it",
    "modena.it",
    "monza-brianza.it",
    "monza-e-della-brianza.it",
    "monza.it",
    "monzabrianza.it",
    "monzaebrianza.it",
    "monzaedellabrianza.it",
    "ms.it",
    "mt.it",
    "na.it",
    "naples.it",
    "napoli.it",
    "no.it",
    "novara.it",
    "nu.it",
    "nuoro.it",
    "og.it",
    "ogliastra.it",
    "olbia-tempio.it",
    "olbiatempio.it",
    "or.it",
    "oristano.it",
    "ot.it",
    "pa.it",
    "padova.it",
    "padua.it",
    "palermo.it",
    "parma.it",
    "pavia.it",
    "pc.it",
    "pd.it",
    "pe.it",
    "perugia.it",
    "pesaro-urbino.it",
    "pesarourbino.it",
    "pescara.it",
    "pg.it",
    "pi.it",
    "piacenza.it",
    "pisa.it",
    "pistoia.it",
    "pn.it",
    "po.it",
    "pordenone.it",
    "potenza.it",
    "pr.it",
    "prato.it",
    "pt.it",
    "pu.it",
    "pv.it",
    "pz.it",
    "ra.it",
    "ragusa.it",
    "ravenna.it",
    "rc.it",
    "re.it",
    "reggio-calabria.it",
    "reggio-emilia.it",
    "reggiocalabria.it",
    "reggioemilia.it",
    "rg.it",
    "ri.it",
    "rieti.it",
    "rimini.it",
    "rm.it",
    "rn.it",
    "ro.it",
    "roma.it",
    "rome.it",
    "rovigo.it",
    "sa.it",
    "salerno.it",
    "sassari.it",
    "savona.it",
    "si.it",
    "siena.it",
    "siracusa.it",
    "so.it",
    "sondrio.it",
    "sp.it",
    "sr.it",
    "ss.it",
    "suedtirol.it",
    "südtirol.it",
    "sv.it",
    "ta.it",
    "taranto.it",
    "te.it",
    "tempio-olbia.it",
    "tempioolbia.it",
    "teramo.it",
    "terni.it",
    "tn.it",
    "to.it",
    "torino.it",
    "tp.it",
    "tr.it",
    "trani-andria-barletta.it",
    "trani-barletta-andria.it",
    "traniandriabarletta.it",
    "tranibarlettaandria.it",
    "trapani.it",
    "trento.it",
    "treviso.it",
    "trieste.it",
    "ts.it",
    "turin.it",
    "tv.it",
    "ud.it",
    "udine.it",
    "urbino-pesaro.it",
    "urbinopesaro.it",
    "va.it",
    "varese.it",
    "vb.it",
    "vc.it",
    "ve.it",
    "venezia.it",
    "venice.it",
    "verbania.it",
    "vercelli.it",
    "verona.it",
    "vi.it",
    "vibo-valentia.it",
    "vibovalentia.it",
    "vicenza.it",
    "viterbo.it",
    "vr.it",
    "vs.it",
    "vt.it",
    "vv.it",
    "je",
    "co.je",
    "net.je",
    "org.je",
    "*.jm",
    "jo",
    "com.jo",
    "org.jo",
    "net.jo",
    "edu.jo",
    "sch.jo",
    "gov.jo",
    "mil.jo",
    "name.jo",
    "jobs",
    "jp",
    "ac.jp",
    "ad.jp",
    "co.jp",
    "ed.jp",
    "go.jp",
    "gr.jp",
    "lg.jp",
    "ne.jp",
    "or.jp",
    "aichi.jp",
    "akita.jp",
    "aomori.jp",
    "chiba.jp",
    "ehime.jp",
    "fukui.jp",
    "fukuoka.jp",
    "fukushima.jp",
    "gifu.jp",
    "gunma.jp",
    "hiroshima.jp",
    "hokkaido.jp",
    "hyogo.jp",
    "ibaraki.jp",
    "ishikawa.jp",
    "iwate.jp",
    "kagawa.jp",
    "kagoshima.jp",
    "kanagawa.jp",
    "kochi.jp",
    "kumamoto.jp",
    "kyoto.jp",
    "mie.jp",
    "miyagi.jp",
    "miyazaki.jp",
    "nagano.jp",
    "nagasaki.jp",
    "nara.jp",
    "niigata.jp",
    "oita.jp",
    "okayama.jp",
    "okinawa.jp",
    "osaka.jp",
    "saga.jp",
    "saitama.jp",
    "shiga.jp",
    "shimane.jp",
    "shizuoka.jp",
    "tochigi.jp",
    "tokushima.jp",
    "tokyo.jp",
    "tottori.jp",
    "toyama.jp",
    "wakayama.jp",
    "yamagata.jp",
    "yamaguchi.jp",
    "yamanashi.jp",
    "栃木.jp",
    "愛知.jp",
    "愛媛.jp",
    "兵庫.jp",
    "熊本.jp",
    "茨城.jp",
    "北海道.jp",
    "千葉.jp",
    "和歌山.jp",
    "長崎.jp",
    "長野.jp",
    "新潟.jp",
    "青森.jp",
    "静岡.jp",
    "東京.jp",
    "石川.jp",
    "埼玉.jp",
    "三重.jp",
    "京都.jp",
    "佐賀.jp",
    "大分.jp",
    "大阪.jp",
    "奈良.jp",
    "宮城.jp",
    "宮崎.jp",
    "富山.jp",
    "山口.jp",
    "山形.jp",
    "山梨.jp",
    "岩手.jp",
    "岐阜.jp",
    "岡山.jp",
    "島根.jp",
    "広島.jp",
    "徳島.jp",
    "沖縄.jp",
    "滋賀.jp",
    "神奈川.jp",
    "福井.jp",
    "福岡.jp",
    "福島.jp",
    "秋田.jp",
    "群馬.jp",
    "香川.jp",
    "高知.jp",
    "鳥取.jp",
    "鹿児島.jp",
    "*.kawasaki.jp",
    "*.kitakyushu.jp",
    "*.kobe.jp",
    "*.nagoya.jp",
    "*.sapporo.jp",
    "*.sendai.jp",
    "*.yokohama.jp",
    "!city.kawasaki.jp",
    "!city.kitakyushu.jp",
    "!city.kobe.jp",
    "!city.nagoya.jp",
    "!city.sapporo.jp",
    "!city.sendai.jp",
    "!city.yokohama.jp",
    "aisai.aichi.jp",
    "ama.aichi.jp",
    "anjo.aichi.jp",
    "asuke.aichi.jp",
    "chiryu.aichi.jp",
    "chita.aichi.jp",
    "fuso.aichi.jp",
    "gamagori.aichi.jp",
    "handa.aichi.jp",
    "hazu.aichi.jp",
    "hekinan.aichi.jp",
    "higashiura.aichi.jp",
    "ichinomiya.aichi.jp",
    "inazawa.aichi.jp",
    "inuyama.aichi.jp",
    "isshiki.aichi.jp",
    "iwakura.aichi.jp",
    "kanie.aichi.jp",
    "kariya.aichi.jp",
    "kasugai.aichi.jp",
    "kira.aichi.jp",
    "kiyosu.aichi.jp",
    "komaki.aichi.jp",
    "konan.aichi.jp",
    "kota.aichi.jp",
    "mihama.aichi.jp",
    "miyoshi.aichi.jp",
    "nishio.aichi.jp",
    "nisshin.aichi.jp",
    "obu.aichi.jp",
    "oguchi.aichi.jp",
    "oharu.aichi.jp",
    "okazaki.aichi.jp",
    "owariasahi.aichi.jp",
    "seto.aichi.jp",
    "shikatsu.aichi.jp",
    "shinshiro.aichi.jp",
    "shitara.aichi.jp",
    "tahara.aichi.jp",
    "takahama.aichi.jp",
    "tobishima.aichi.jp",
    "toei.aichi.jp",
    "togo.aichi.jp",
    "tokai.aichi.jp",
    "tokoname.aichi.jp",
    "toyoake.aichi.jp",
    "toyohashi.aichi.jp",
    "toyokawa.aichi.jp",
    "toyone.aichi.jp",
    "toyota.aichi.jp",
    "tsushima.aichi.jp",
    "yatomi.aichi.jp",
    "akita.akita.jp",
    "daisen.akita.jp",
    "fujisato.akita.jp",
    "gojome.akita.jp",
    "hachirogata.akita.jp",
    "happou.akita.jp",
    "higashinaruse.akita.jp",
    "honjo.akita.jp",
    "honjyo.akita.jp",
    "ikawa.akita.jp",
    "kamikoani.akita.jp",
    "kamioka.akita.jp",
    "katagami.akita.jp",
    "kazuno.akita.jp",
    "kitaakita.akita.jp",
    "kosaka.akita.jp",
    "kyowa.akita.jp",
    "misato.akita.jp",
    "mitane.akita.jp",
    "moriyoshi.akita.jp",
    "nikaho.akita.jp",
    "noshiro.akita.jp",
    "odate.akita.jp",
    "oga.akita.jp",
    "ogata.akita.jp",
    "semboku.akita.jp",
    "yokote.akita.jp",
    "yurihonjo.akita.jp",
    "aomori.aomori.jp",
    "gonohe.aomori.jp",
    "hachinohe.aomori.jp",
    "hashikami.aomori.jp",
    "hiranai.aomori.jp",
    "hirosaki.aomori.jp",
    "itayanagi.aomori.jp",
    "kuroishi.aomori.jp",
    "misawa.aomori.jp",
    "mutsu.aomori.jp",
    "nakadomari.aomori.jp",
    "noheji.aomori.jp",
    "oirase.aomori.jp",
    "owani.aomori.jp",
    "rokunohe.aomori.jp",
    "sannohe.aomori.jp",
    "shichinohe.aomori.jp",
    "shingo.aomori.jp",
    "takko.aomori.jp",
    "towada.aomori.jp",
    "tsugaru.aomori.jp",
    "tsuruta.aomori.jp",
    "abiko.chiba.jp",
    "asahi.chiba.jp",
    "chonan.chiba.jp",
    "chosei.chiba.jp",
    "choshi.chiba.jp",
    "chuo.chiba.jp",
    "funabashi.chiba.jp",
    "futtsu.chiba.jp",
    "hanamigawa.chiba.jp",
    "ichihara.chiba.jp",
    "ichikawa.chiba.jp",
    "ichinomiya.chiba.jp",
    "inzai.chiba.jp",
    "isumi.chiba.jp",
    "kamagaya.chiba.jp",
    "kamogawa.chiba.jp",
    "kashiwa.chiba.jp",
    "katori.chiba.jp",
    "katsuura.chiba.jp",
    "kimitsu.chiba.jp",
    "kisarazu.chiba.jp",
    "kozaki.chiba.jp",
    "kujukuri.chiba.jp",
    "kyonan.chiba.jp",
    "matsudo.chiba.jp",
    "midori.chiba.jp",
    "mihama.chiba.jp",
    "minamiboso.chiba.jp",
    "mobara.chiba.jp",
    "mutsuzawa.chiba.jp",
    "nagara.chiba.jp",
    "nagareyama.chiba.jp",
    "narashino.chiba.jp",
    "narita.chiba.jp",
    "noda.chiba.jp",
    "oamishirasato.chiba.jp",
    "omigawa.chiba.jp",
    "onjuku.chiba.jp",
    "otaki.chiba.jp",
    "sakae.chiba.jp",
    "sakura.chiba.jp",
    "shimofusa.chiba.jp",
    "shirako.chiba.jp",
    "shiroi.chiba.jp",
    "shisui.chiba.jp",
    "sodegaura.chiba.jp",
    "sosa.chiba.jp",
    "tako.chiba.jp",
    "tateyama.chiba.jp",
    "togane.chiba.jp",
    "tohnosho.chiba.jp",
    "tomisato.chiba.jp",
    "urayasu.chiba.jp",
    "yachimata.chiba.jp",
    "yachiyo.chiba.jp",
    "yokaichiba.chiba.jp",
    "yokoshibahikari.chiba.jp",
    "yotsukaido.chiba.jp",
    "ainan.ehime.jp",
    "honai.ehime.jp",
    "ikata.ehime.jp",
    "imabari.ehime.jp",
    "iyo.ehime.jp",
    "kamijima.ehime.jp",
    "kihoku.ehime.jp",
    "kumakogen.ehime.jp",
    "masaki.ehime.jp",
    "matsuno.ehime.jp",
    "matsuyama.ehime.jp",
    "namikata.ehime.jp",
    "niihama.ehime.jp",
    "ozu.ehime.jp",
    "saijo.ehime.jp",
    "seiyo.ehime.jp",
    "shikokuchuo.ehime.jp",
    "tobe.ehime.jp",
    "toon.ehime.jp",
    "uchiko.ehime.jp",
    "uwajima.ehime.jp",
    "yawatahama.ehime.jp",
    "echizen.fukui.jp",
    "eiheiji.fukui.jp",
    "fukui.fukui.jp",
    "ikeda.fukui.jp",
    "katsuyama.fukui.jp",
    "mihama.fukui.jp",
    "minamiechizen.fukui.jp",
    "obama.fukui.jp",
    "ohi.fukui.jp",
    "ono.fukui.jp",
    "sabae.fukui.jp",
    "sakai.fukui.jp",
    "takahama.fukui.jp",
    "tsuruga.fukui.jp",
    "wakasa.fukui.jp",
    "ashiya.fukuoka.jp",
    "buzen.fukuoka.jp",
    "chikugo.fukuoka.jp",
    "chikuho.fukuoka.jp",
    "chikujo.fukuoka.jp",
    "chikushino.fukuoka.jp",
    "chikuzen.fukuoka.jp",
    "chuo.fukuoka.jp",
    "dazaifu.fukuoka.jp",
    "fukuchi.fukuoka.jp",
    "hakata.fukuoka.jp",
    "higashi.fukuoka.jp",
    "hirokawa.fukuoka.jp",
    "hisayama.fukuoka.jp",
    "iizuka.fukuoka.jp",
    "inatsuki.fukuoka.jp",
    "kaho.fukuoka.jp",
    "kasuga.fukuoka.jp",
    "kasuya.fukuoka.jp",
    "kawara.fukuoka.jp",
    "keisen.fukuoka.jp",
    "koga.fukuoka.jp",
    "kurate.fukuoka.jp",
    "kurogi.fukuoka.jp",
    "kurume.fukuoka.jp",
    "minami.fukuoka.jp",
    "miyako.fukuoka.jp",
    "miyama.fukuoka.jp",
    "miyawaka.fukuoka.jp",
    "mizumaki.fukuoka.jp",
    "munakata.fukuoka.jp",
    "nakagawa.fukuoka.jp",
    "nakama.fukuoka.jp",
    "nishi.fukuoka.jp",
    "nogata.fukuoka.jp",
    "ogori.fukuoka.jp",
    "okagaki.fukuoka.jp",
    "okawa.fukuoka.jp",
    "oki.fukuoka.jp",
    "omuta.fukuoka.jp",
    "onga.fukuoka.jp",
    "onojo.fukuoka.jp",
    "oto.fukuoka.jp",
    "saigawa.fukuoka.jp",
    "sasaguri.fukuoka.jp",
    "shingu.fukuoka.jp",
    "shinyoshitomi.fukuoka.jp",
    "shonai.fukuoka.jp",
    "soeda.fukuoka.jp",
    "sue.fukuoka.jp",
    "tachiarai.fukuoka.jp",
    "tagawa.fukuoka.jp",
    "takata.fukuoka.jp",
    "toho.fukuoka.jp",
    "toyotsu.fukuoka.jp",
    "tsuiki.fukuoka.jp",
    "ukiha.fukuoka.jp",
    "umi.fukuoka.jp",
    "usui.fukuoka.jp",
    "yamada.fukuoka.jp",
    "yame.fukuoka.jp",
    "yanagawa.fukuoka.jp",
    "yukuhashi.fukuoka.jp",
    "aizubange.fukushima.jp",
    "aizumisato.fukushima.jp",
    "aizuwakamatsu.fukushima.jp",
    "asakawa.fukushima.jp",
    "bandai.fukushima.jp",
    "date.fukushima.jp",
    "fukushima.fukushima.jp",
    "furudono.fukushima.jp",
    "futaba.fukushima.jp",
    "hanawa.fukushima.jp",
    "higashi.fukushima.jp",
    "hirata.fukushima.jp",
    "hirono.fukushima.jp",
    "iitate.fukushima.jp",
    "inawashiro.fukushima.jp",
    "ishikawa.fukushima.jp",
    "iwaki.fukushima.jp",
    "izumizaki.fukushima.jp",
    "kagamiishi.fukushima.jp",
    "kaneyama.fukushima.jp",
    "kawamata.fukushima.jp",
    "kitakata.fukushima.jp",
    "kitashiobara.fukushima.jp",
    "koori.fukushima.jp",
    "koriyama.fukushima.jp",
    "kunimi.fukushima.jp",
    "miharu.fukushima.jp",
    "mishima.fukushima.jp",
    "namie.fukushima.jp",
    "nango.fukushima.jp",
    "nishiaizu.fukushima.jp",
    "nishigo.fukushima.jp",
    "okuma.fukushima.jp",
    "omotego.fukushima.jp",
    "ono.fukushima.jp",
    "otama.fukushima.jp",
    "samegawa.fukushima.jp",
    "shimogo.fukushima.jp",
    "shirakawa.fukushima.jp",
    "showa.fukushima.jp",
    "soma.fukushima.jp",
    "sukagawa.fukushima.jp",
    "taishin.fukushima.jp",
    "tamakawa.fukushima.jp",
    "tanagura.fukushima.jp",
    "tenei.fukushima.jp",
    "yabuki.fukushima.jp",
    "yamato.fukushima.jp",
    "yamatsuri.fukushima.jp",
    "yanaizu.fukushima.jp",
    "yugawa.fukushima.jp",
    "anpachi.gifu.jp",
    "ena.gifu.jp",
    "gifu.gifu.jp",
    "ginan.gifu.jp",
    "godo.gifu.jp",
    "gujo.gifu.jp",
    "hashima.gifu.jp",
    "hichiso.gifu.jp",
    "hida.gifu.jp",
    "higashishirakawa.gifu.jp",
    "ibigawa.gifu.jp",
    "ikeda.gifu.jp",
    "kakamigahara.gifu.jp",
    "kani.gifu.jp",
    "kasahara.gifu.jp",
    "kasamatsu.gifu.jp",
    "kawaue.gifu.jp",
    "kitagata.gifu.jp",
    "mino.gifu.jp",
    "minokamo.gifu.jp",
    "mitake.gifu.jp",
    "mizunami.gifu.jp",
    "motosu.gifu.jp",
    "nakatsugawa.gifu.jp",
    "ogaki.gifu.jp",
    "sakahogi.gifu.jp",
    "seki.gifu.jp",
    "sekigahara.gifu.jp",
    "shirakawa.gifu.jp",
    "tajimi.gifu.jp",
    "takayama.gifu.jp",
    "tarui.gifu.jp",
    "toki.gifu.jp",
    "tomika.gifu.jp",
    "wanouchi.gifu.jp",
    "yamagata.gifu.jp",
    "yaotsu.gifu.jp",
    "yoro.gifu.jp",
    "annaka.gunma.jp",
    "chiyoda.gunma.jp",
    "fujioka.gunma.jp",
    "higashiagatsuma.gunma.jp",
    "isesaki.gunma.jp",
    "itakura.gunma.jp",
    "kanna.gunma.jp",
    "kanra.gunma.jp",
    "katashina.gunma.jp",
    "kawaba.gunma.jp",
    "kiryu.gunma.jp",
    "kusatsu.gunma.jp",
    "maebashi.gunma.jp",
    "meiwa.gunma.jp",
    "midori.gunma.jp",
    "minakami.gunma.jp",
    "naganohara.gunma.jp",
    "nakanojo.gunma.jp",
    "nanmoku.gunma.jp",
    "numata.gunma.jp",
    "oizumi.gunma.jp",
    "ora.gunma.jp",
    "ota.gunma.jp",
    "shibukawa.gunma.jp",
    "shimonita.gunma.jp",
    "shinto.gunma.jp",
    "showa.gunma.jp",
    "takasaki.gunma.jp",
    "takayama.gunma.jp",
    "tamamura.gunma.jp",
    "tatebayashi.gunma.jp",
    "tomioka.gunma.jp",
    "tsukiyono.gunma.jp",
    "tsumagoi.gunma.jp",
    "ueno.gunma.jp",
    "yoshioka.gunma.jp",
    "asaminami.hiroshima.jp",
    "daiwa.hiroshima.jp",
    "etajima.hiroshima.jp",
    "fuchu.hiroshima.jp",
    "fukuyama.hiroshima.jp",
    "hatsukaichi.hiroshima.jp",
    "higashihiroshima.hiroshima.jp",
    "hongo.hiroshima.jp",
    "jinsekikogen.hiroshima.jp",
    "kaita.hiroshima.jp",
    "kui.hiroshima.jp",
    "kumano.hiroshima.jp",
    "kure.hiroshima.jp",
    "mihara.hiroshima.jp",
    "miyoshi.hiroshima.jp",
    "naka.hiroshima.jp",
    "onomichi.hiroshima.jp",
    "osakikamijima.hiroshima.jp",
    "otake.hiroshima.jp",
    "saka.hiroshima.jp",
    "sera.hiroshima.jp",
    "seranishi.hiroshima.jp",
    "shinichi.hiroshima.jp",
    "shobara.hiroshima.jp",
    "takehara.hiroshima.jp",
    "abashiri.hokkaido.jp",
    "abira.hokkaido.jp",
    "aibetsu.hokkaido.jp",
    "akabira.hokkaido.jp",
    "akkeshi.hokkaido.jp",
    "asahikawa.hokkaido.jp",
    "ashibetsu.hokkaido.jp",
    "ashoro.hokkaido.jp",
    "assabu.hokkaido.jp",
    "atsuma.hokkaido.jp",
    "bibai.hokkaido.jp",
    "biei.hokkaido.jp",
    "bifuka.hokkaido.jp",
    "bihoro.hokkaido.jp",
    "biratori.hokkaido.jp",
    "chippubetsu.hokkaido.jp",
    "chitose.hokkaido.jp",
    "date.hokkaido.jp",
    "ebetsu.hokkaido.jp",
    "embetsu.hokkaido.jp",
    "eniwa.hokkaido.jp",
    "erimo.hokkaido.jp",
    "esan.hokkaido.jp",
    "esashi.hokkaido.jp",
    "fukagawa.hokkaido.jp",
    "fukushima.hokkaido.jp",
    "furano.hokkaido.jp",
    "furubira.hokkaido.jp",
    "haboro.hokkaido.jp",
    "hakodate.hokkaido.jp",
    "hamatonbetsu.hokkaido.jp",
    "hidaka.hokkaido.jp",
    "higashikagura.hokkaido.jp",
    "higashikawa.hokkaido.jp",
    "hiroo.hokkaido.jp",
    "hokuryu.hokkaido.jp",
    "hokuto.hokkaido.jp",
    "honbetsu.hokkaido.jp",
    "horokanai.hokkaido.jp",
    "horonobe.hokkaido.jp",
    "ikeda.hokkaido.jp",
    "imakane.hokkaido.jp",
    "ishikari.hokkaido.jp",
    "iwamizawa.hokkaido.jp",
    "iwanai.hokkaido.jp",
    "kamifurano.hokkaido.jp",
    "kamikawa.hokkaido.jp",
    "kamishihoro.hokkaido.jp",
    "kamisunagawa.hokkaido.jp",
    "kamoenai.hokkaido.jp",
    "kayabe.hokkaido.jp",
    "kembuchi.hokkaido.jp",
    "kikonai.hokkaido.jp",
    "kimobetsu.hokkaido.jp",
    "kitahiroshima.hokkaido.jp",
    "kitami.hokkaido.jp",
    "kiyosato.hokkaido.jp",
    "koshimizu.hokkaido.jp",
    "kunneppu.hokkaido.jp",
    "kuriyama.hokkaido.jp",
    "kuromatsunai.hokkaido.jp",
    "kushiro.hokkaido.jp",
    "kutchan.hokkaido.jp",
    "kyowa.hokkaido.jp",
    "mashike.hokkaido.jp",
    "matsumae.hokkaido.jp",
    "mikasa.hokkaido.jp",
    "minamifurano.hokkaido.jp",
    "mombetsu.hokkaido.jp",
    "moseushi.hokkaido.jp",
    "mukawa.hokkaido.jp",
    "muroran.hokkaido.jp",
    "naie.hokkaido.jp",
    "nakagawa.hokkaido.jp",
    "nakasatsunai.hokkaido.jp",
    "nakatombetsu.hokkaido.jp",
    "nanae.hokkaido.jp",
    "nanporo.hokkaido.jp",
    "nayoro.hokkaido.jp",
    "nemuro.hokkaido.jp",
    "niikappu.hokkaido.jp",
    "niki.hokkaido.jp",
    "nishiokoppe.hokkaido.jp",
    "noboribetsu.hokkaido.jp",
    "numata.hokkaido.jp",
    "obihiro.hokkaido.jp",
    "obira.hokkaido.jp",
    "oketo.hokkaido.jp",
    "okoppe.hokkaido.jp",
    "otaru.hokkaido.jp",
    "otobe.hokkaido.jp",
    "otofuke.hokkaido.jp",
    "otoineppu.hokkaido.jp",
    "oumu.hokkaido.jp",
    "ozora.hokkaido.jp",
    "pippu.hokkaido.jp",
    "rankoshi.hokkaido.jp",
    "rebun.hokkaido.jp",
    "rikubetsu.hokkaido.jp",
    "rishiri.hokkaido.jp",
    "rishirifuji.hokkaido.jp",
    "saroma.hokkaido.jp",
    "sarufutsu.hokkaido.jp",
    "shakotan.hokkaido.jp",
    "shari.hokkaido.jp",
    "shibecha.hokkaido.jp",
    "shibetsu.hokkaido.jp",
    "shikabe.hokkaido.jp",
    "shikaoi.hokkaido.jp",
    "shimamaki.hokkaido.jp",
    "shimizu.hokkaido.jp",
    "shimokawa.hokkaido.jp",
    "shinshinotsu.hokkaido.jp",
    "shintoku.hokkaido.jp",
    "shiranuka.hokkaido.jp",
    "shiraoi.hokkaido.jp",
    "shiriuchi.hokkaido.jp",
    "sobetsu.hokkaido.jp",
    "sunagawa.hokkaido.jp",
    "taiki.hokkaido.jp",
    "takasu.hokkaido.jp",
    "takikawa.hokkaido.jp",
    "takinoue.hokkaido.jp",
    "teshikaga.hokkaido.jp",
    "tobetsu.hokkaido.jp",
    "tohma.hokkaido.jp",
    "tomakomai.hokkaido.jp",
    "tomari.hokkaido.jp",
    "toya.hokkaido.jp",
    "toyako.hokkaido.jp",
    "toyotomi.hokkaido.jp",
    "toyoura.hokkaido.jp",
    "tsubetsu.hokkaido.jp",
    "tsukigata.hokkaido.jp",
    "urakawa.hokkaido.jp",
    "urausu.hokkaido.jp",
    "uryu.hokkaido.jp",
    "utashinai.hokkaido.jp",
    "wakkanai.hokkaido.jp",
    "wassamu.hokkaido.jp",
    "yakumo.hokkaido.jp",
    "yoichi.hokkaido.jp",
    "aioi.hyogo.jp",
    "akashi.hyogo.jp",
    "ako.hyogo.jp",
    "amagasaki.hyogo.jp",
    "aogaki.hyogo.jp",
    "asago.hyogo.jp",
    "ashiya.hyogo.jp",
    "awaji.hyogo.jp",
    "fukusaki.hyogo.jp",
    "goshiki.hyogo.jp",
    "harima.hyogo.jp",
    "himeji.hyogo.jp",
    "ichikawa.hyogo.jp",
    "inagawa.hyogo.jp",
    "itami.hyogo.jp",
    "kakogawa.hyogo.jp",
    "kamigori.hyogo.jp",
    "kamikawa.hyogo.jp",
    "kasai.hyogo.jp",
    "kasuga.hyogo.jp",
    "kawanishi.hyogo.jp",
    "miki.hyogo.jp",
    "minamiawaji.hyogo.jp",
    "nishinomiya.hyogo.jp",
    "nishiwaki.hyogo.jp",
    "ono.hyogo.jp",
    "sanda.hyogo.jp",
    "sannan.hyogo.jp",
    "sasayama.hyogo.jp",
    "sayo.hyogo.jp",
    "shingu.hyogo.jp",
    "shinonsen.hyogo.jp",
    "shiso.hyogo.jp",
    "sumoto.hyogo.jp",
    "taishi.hyogo.jp",
    "taka.hyogo.jp",
    "takarazuka.hyogo.jp",
    "takasago.hyogo.jp",
    "takino.hyogo.jp",
    "tamba.hyogo.jp",
    "tatsuno.hyogo.jp",
    "toyooka.hyogo.jp",
    "yabu.hyogo.jp",
    "yashiro.hyogo.jp",
    "yoka.hyogo.jp",
    "yokawa.hyogo.jp",
    "ami.ibaraki.jp",
    "asahi.ibaraki.jp",
    "bando.ibaraki.jp",
    "chikusei.ibaraki.jp",
    "daigo.ibaraki.jp",
    "fujishiro.ibaraki.jp",
    "hitachi.ibaraki.jp",
    "hitachinaka.ibaraki.jp",
    "hitachiomiya.ibaraki.jp",
    "hitachiota.ibaraki.jp",
    "ibaraki.ibaraki.jp",
    "ina.ibaraki.jp",
    "inashiki.ibaraki.jp",
    "itako.ibaraki.jp",
    "iwama.ibaraki.jp",
    "joso.ibaraki.jp",
    "kamisu.ibaraki.jp",
    "kasama.ibaraki.jp",
    "kashima.ibaraki.jp",
    "kasumigaura.ibaraki.jp",
    "koga.ibaraki.jp",
    "miho.ibaraki.jp",
    "mito.ibaraki.jp",
    "moriya.ibaraki.jp",
    "naka.ibaraki.jp",
    "namegata.ibaraki.jp",
    "oarai.ibaraki.jp",
    "ogawa.ibaraki.jp",
    "omitama.ibaraki.jp",
    "ryugasaki.ibaraki.jp",
    "sakai.ibaraki.jp",
    "sakuragawa.ibaraki.jp",
    "shimodate.ibaraki.jp",
    "shimotsuma.ibaraki.jp",
    "shirosato.ibaraki.jp",
    "sowa.ibaraki.jp",
    "suifu.ibaraki.jp",
    "takahagi.ibaraki.jp",
    "tamatsukuri.ibaraki.jp",
    "tokai.ibaraki.jp",
    "tomobe.ibaraki.jp",
    "tone.ibaraki.jp",
    "toride.ibaraki.jp",
    "tsuchiura.ibaraki.jp",
    "tsukuba.ibaraki.jp",
    "uchihara.ibaraki.jp",
    "ushiku.ibaraki.jp",
    "yachiyo.ibaraki.jp",
    "yamagata.ibaraki.jp",
    "yawara.ibaraki.jp",
    "yuki.ibaraki.jp",
    "anamizu.ishikawa.jp",
    "hakui.ishikawa.jp",
    "hakusan.ishikawa.jp",
    "kaga.ishikawa.jp",
    "kahoku.ishikawa.jp",
    "kanazawa.ishikawa.jp",
    "kawakita.ishikawa.jp",
    "komatsu.ishikawa.jp",
    "nakanoto.ishikawa.jp",
    "nanao.ishikawa.jp",
    "nomi.ishikawa.jp",
    "nonoichi.ishikawa.jp",
    "noto.ishikawa.jp",
    "shika.ishikawa.jp",
    "suzu.ishikawa.jp",
    "tsubata.ishikawa.jp",
    "tsurugi.ishikawa.jp",
    "uchinada.ishikawa.jp",
    "wajima.ishikawa.jp",
    "fudai.iwate.jp",
    "fujisawa.iwate.jp",
    "hanamaki.iwate.jp",
    "hiraizumi.iwate.jp",
    "hirono.iwate.jp",
    "ichinohe.iwate.jp",
    "ichinoseki.iwate.jp",
    "iwaizumi.iwate.jp",
    "iwate.iwate.jp",
    "joboji.iwate.jp",
    "kamaishi.iwate.jp",
    "kanegasaki.iwate.jp",
    "karumai.iwate.jp",
    "kawai.iwate.jp",
    "kitakami.iwate.jp",
    "kuji.iwate.jp",
    "kunohe.iwate.jp",
    "kuzumaki.iwate.jp",
    "miyako.iwate.jp",
    "mizusawa.iwate.jp",
    "morioka.iwate.jp",
    "ninohe.iwate.jp",
    "noda.iwate.jp",
    "ofunato.iwate.jp",
    "oshu.iwate.jp",
    "otsuchi.iwate.jp",
    "rikuzentakata.iwate.jp",
    "shiwa.iwate.jp",
    "shizukuishi.iwate.jp",
    "sumita.iwate.jp",
    "tanohata.iwate.jp",
    "tono.iwate.jp",
    "yahaba.iwate.jp",
    "yamada.iwate.jp",
    "ayagawa.kagawa.jp",
    "higashikagawa.kagawa.jp",
    "kanonji.kagawa.jp",
    "kotohira.kagawa.jp",
    "manno.kagawa.jp",
    "marugame.kagawa.jp",
    "mitoyo.kagawa.jp",
    "naoshima.kagawa.jp",
    "sanuki.kagawa.jp",
    "tadotsu.kagawa.jp",
    "takamatsu.kagawa.jp",
    "tonosho.kagawa.jp",
    "uchinomi.kagawa.jp",
    "utazu.kagawa.jp",
    "zentsuji.kagawa.jp",
    "akune.kagoshima.jp",
    "amami.kagoshima.jp",
    "hioki.kagoshima.jp",
    "isa.kagoshima.jp",
    "isen.kagoshima.jp",
    "izumi.kagoshima.jp",
    "kagoshima.kagoshima.jp",
    "kanoya.kagoshima.jp",
    "kawanabe.kagoshima.jp",
    "kinko.kagoshima.jp",
    "kouyama.kagoshima.jp",
    "makurazaki.kagoshima.jp",
    "matsumoto.kagoshima.jp",
    "minamitane.kagoshima.jp",
    "nakatane.kagoshima.jp",
    "nishinoomote.kagoshima.jp",
    "satsumasendai.kagoshima.jp",
    "soo.kagoshima.jp",
    "tarumizu.kagoshima.jp",
    "yusui.kagoshima.jp",
    "aikawa.kanagawa.jp",
    "atsugi.kanagawa.jp",
    "ayase.kanagawa.jp",
    "chigasaki.kanagawa.jp",
    "ebina.kanagawa.jp",
    "fujisawa.kanagawa.jp",
    "hadano.kanagawa.jp",
    "hakone.kanagawa.jp",
    "hiratsuka.kanagawa.jp",
    "isehara.kanagawa.jp",
    "kaisei.kanagawa.jp",
    "kamakura.kanagawa.jp",
    "kiyokawa.kanagawa.jp",
    "matsuda.kanagawa.jp",
    "minamiashigara.kanagawa.jp",
    "miura.kanagawa.jp",
    "nakai.kanagawa.jp",
    "ninomiya.kanagawa.jp",
    "odawara.kanagawa.jp",
    "oi.kanagawa.jp",
    "oiso.kanagawa.jp",
    "sagamihara.kanagawa.jp",
    "samukawa.kanagawa.jp",
    "tsukui.kanagawa.jp",
    "yamakita.kanagawa.jp",
    "yamato.kanagawa.jp",
    "yokosuka.kanagawa.jp",
    "yugawara.kanagawa.jp",
    "zama.kanagawa.jp",
    "zushi.kanagawa.jp",
    "aki.kochi.jp",
    "geisei.kochi.jp",
    "hidaka.kochi.jp",
    "higashitsuno.kochi.jp",
    "ino.kochi.jp",
    "kagami.kochi.jp",
    "kami.kochi.jp",
    "kitagawa.kochi.jp",
    "kochi.kochi.jp",
    "mihara.kochi.jp",
    "motoyama.kochi.jp",
    "muroto.kochi.jp",
    "nahari.kochi.jp",
    "nakamura.kochi.jp",
    "nankoku.kochi.jp",
    "nishitosa.kochi.jp",
    "niyodogawa.kochi.jp",
    "ochi.kochi.jp",
    "okawa.kochi.jp",
    "otoyo.kochi.jp",
    "otsuki.kochi.jp",
    "sakawa.kochi.jp",
    "sukumo.kochi.jp",
    "susaki.kochi.jp",
    "tosa.kochi.jp",
    "tosashimizu.kochi.jp",
    "toyo.kochi.jp",
    "tsuno.kochi.jp",
    "umaji.kochi.jp",
    "yasuda.kochi.jp",
    "yusuhara.kochi.jp",
    "amakusa.kumamoto.jp",
    "arao.kumamoto.jp",
    "aso.kumamoto.jp",
    "choyo.kumamoto.jp",
    "gyokuto.kumamoto.jp",
    "kamiamakusa.kumamoto.jp",
    "kikuchi.kumamoto.jp",
    "kumamoto.kumamoto.jp",
    "mashiki.kumamoto.jp",
    "mifune.kumamoto.jp",
    "minamata.kumamoto.jp",
    "minamioguni.kumamoto.jp",
    "nagasu.kumamoto.jp",
    "nishihara.kumamoto.jp",
    "oguni.kumamoto.jp",
    "ozu.kumamoto.jp",
    "sumoto.kumamoto.jp",
    "takamori.kumamoto.jp",
    "uki.kumamoto.jp",
    "uto.kumamoto.jp",
    "yamaga.kumamoto.jp",
    "yamato.kumamoto.jp",
    "yatsushiro.kumamoto.jp",
    "ayabe.kyoto.jp",
    "fukuchiyama.kyoto.jp",
    "higashiyama.kyoto.jp",
    "ide.kyoto.jp",
    "ine.kyoto.jp",
    "joyo.kyoto.jp",
    "kameoka.kyoto.jp",
    "kamo.kyoto.jp",
    "kita.kyoto.jp",
    "kizu.kyoto.jp",
    "kumiyama.kyoto.jp",
    "kyotamba.kyoto.jp",
    "kyotanabe.kyoto.jp",
    "kyotango.kyoto.jp",
    "maizuru.kyoto.jp",
    "minami.kyoto.jp",
    "minamiyamashiro.kyoto.jp",
    "miyazu.kyoto.jp",
    "muko.kyoto.jp",
    "nagaokakyo.kyoto.jp",
    "nakagyo.kyoto.jp",
    "nantan.kyoto.jp",
    "oyamazaki.kyoto.jp",
    "sakyo.kyoto.jp",
    "seika.kyoto.jp",
    "tanabe.kyoto.jp",
    "uji.kyoto.jp",
    "ujitawara.kyoto.jp",
    "wazuka.kyoto.jp",
    "yamashina.kyoto.jp",
    "yawata.kyoto.jp",
    "asahi.mie.jp",
    "inabe.mie.jp",
    "ise.mie.jp",
    "kameyama.mie.jp",
    "kawagoe.mie.jp",
    "kiho.mie.jp",
    "kisosaki.mie.jp",
    "kiwa.mie.jp",
    "komono.mie.jp",
    "kumano.mie.jp",
    "kuwana.mie.jp",
    "matsusaka.mie.jp",
    "meiwa.mie.jp",
    "mihama.mie.jp",
    "minamiise.mie.jp",
    "misugi.mie.jp",
    "miyama.mie.jp",
    "nabari.mie.jp",
    "shima.mie.jp",
    "suzuka.mie.jp",
    "tado.mie.jp",
    "taiki.mie.jp",
    "taki.mie.jp",
    "tamaki.mie.jp",
    "toba.mie.jp",
    "tsu.mie.jp",
    "udono.mie.jp",
    "ureshino.mie.jp",
    "watarai.mie.jp",
    "yokkaichi.mie.jp",
    "furukawa.miyagi.jp",
    "higashimatsushima.miyagi.jp",
    "ishinomaki.miyagi.jp",
    "iwanuma.miyagi.jp",
    "kakuda.miyagi.jp",
    "kami.miyagi.jp",
    "kawasaki.miyagi.jp",
    "marumori.miyagi.jp",
    "matsushima.miyagi.jp",
    "minamisanriku.miyagi.jp",
    "misato.miyagi.jp",
    "murata.miyagi.jp",
    "natori.miyagi.jp",
    "ogawara.miyagi.jp",
    "ohira.miyagi.jp",
    "onagawa.miyagi.jp",
    "osaki.miyagi.jp",
    "rifu.miyagi.jp",
    "semine.miyagi.jp",
    "shibata.miyagi.jp",
    "shichikashuku.miyagi.jp",
    "shikama.miyagi.jp",
    "shiogama.miyagi.jp",
    "shiroishi.miyagi.jp",
    "tagajo.miyagi.jp",
    "taiwa.miyagi.jp",
    "tome.miyagi.jp",
    "tomiya.miyagi.jp",
    "wakuya.miyagi.jp",
    "watari.miyagi.jp",
    "yamamoto.miyagi.jp",
    "zao.miyagi.jp",
    "aya.miyazaki.jp",
    "ebino.miyazaki.jp",
    "gokase.miyazaki.jp",
    "hyuga.miyazaki.jp",
    "kadogawa.miyazaki.jp",
    "kawaminami.miyazaki.jp",
    "kijo.miyazaki.jp",
    "kitagawa.miyazaki.jp",
    "kitakata.miyazaki.jp",
    "kitaura.miyazaki.jp",
    "kobayashi.miyazaki.jp",
    "kunitomi.miyazaki.jp",
    "kushima.miyazaki.jp",
    "mimata.miyazaki.jp",
    "miyakonojo.miyazaki.jp",
    "miyazaki.miyazaki.jp",
    "morotsuka.miyazaki.jp",
    "nichinan.miyazaki.jp",
    "nishimera.miyazaki.jp",
    "nobeoka.miyazaki.jp",
    "saito.miyazaki.jp",
    "shiiba.miyazaki.jp",
    "shintomi.miyazaki.jp",
    "takaharu.miyazaki.jp",
    "takanabe.miyazaki.jp",
    "takazaki.miyazaki.jp",
    "tsuno.miyazaki.jp",
    "achi.nagano.jp",
    "agematsu.nagano.jp",
    "anan.nagano.jp",
    "aoki.nagano.jp",
    "asahi.nagano.jp",
    "azumino.nagano.jp",
    "chikuhoku.nagano.jp",
    "chikuma.nagano.jp",
    "chino.nagano.jp",
    "fujimi.nagano.jp",
    "hakuba.nagano.jp",
    "hara.nagano.jp",
    "hiraya.nagano.jp",
    "iida.nagano.jp",
    "iijima.nagano.jp",
    "iiyama.nagano.jp",
    "iizuna.nagano.jp",
    "ikeda.nagano.jp",
    "ikusaka.nagano.jp",
    "ina.nagano.jp",
    "karuizawa.nagano.jp",
    "kawakami.nagano.jp",
    "kiso.nagano.jp",
    "kisofukushima.nagano.jp",
    "kitaaiki.nagano.jp",
    "komagane.nagano.jp",
    "komoro.nagano.jp",
    "matsukawa.nagano.jp",
    "matsumoto.nagano.jp",
    "miasa.nagano.jp",
    "minamiaiki.nagano.jp",
    "minamimaki.nagano.jp",
    "minamiminowa.nagano.jp",
    "minowa.nagano.jp",
    "miyada.nagano.jp",
    "miyota.nagano.jp",
    "mochizuki.nagano.jp",
    "nagano.nagano.jp",
    "nagawa.nagano.jp",
    "nagiso.nagano.jp",
    "nakagawa.nagano.jp",
    "nakano.nagano.jp",
    "nozawaonsen.nagano.jp",
    "obuse.nagano.jp",
    "ogawa.nagano.jp",
    "okaya.nagano.jp",
    "omachi.nagano.jp",
    "omi.nagano.jp",
    "ookuwa.nagano.jp",
    "ooshika.nagano.jp",
    "otaki.nagano.jp",
    "otari.nagano.jp",
    "sakae.nagano.jp",
    "sakaki.nagano.jp",
    "saku.nagano.jp",
    "sakuho.nagano.jp",
    "shimosuwa.nagano.jp",
    "shinanomachi.nagano.jp",
    "shiojiri.nagano.jp",
    "suwa.nagano.jp",
    "suzaka.nagano.jp",
    "takagi.nagano.jp",
    "takamori.nagano.jp",
    "takayama.nagano.jp",
    "tateshina.nagano.jp",
    "tatsuno.nagano.jp",
    "togakushi.nagano.jp",
    "togura.nagano.jp",
    "tomi.nagano.jp",
    "ueda.nagano.jp",
    "wada.nagano.jp",
    "yamagata.nagano.jp",
    "yamanouchi.nagano.jp",
    "yasaka.nagano.jp",
    "yasuoka.nagano.jp",
    "chijiwa.nagasaki.jp",
    "futsu.nagasaki.jp",
    "goto.nagasaki.jp",
    "hasami.nagasaki.jp",
    "hirado.nagasaki.jp",
    "iki.nagasaki.jp",
    "isahaya.nagasaki.jp",
    "kawatana.nagasaki.jp",
    "kuchinotsu.nagasaki.jp",
    "matsuura.nagasaki.jp",
    "nagasaki.nagasaki.jp",
    "obama.nagasaki.jp",
    "omura.nagasaki.jp",
    "oseto.nagasaki.jp",
    "saikai.nagasaki.jp",
    "sasebo.nagasaki.jp",
    "seihi.nagasaki.jp",
    "shimabara.nagasaki.jp",
    "shinkamigoto.nagasaki.jp",
    "togitsu.nagasaki.jp",
    "tsushima.nagasaki.jp",
    "unzen.nagasaki.jp",
    "ando.nara.jp",
    "gose.nara.jp",
    "heguri.nara.jp",
    "higashiyoshino.nara.jp",
    "ikaruga.nara.jp",
    "ikoma.nara.jp",
    "kamikitayama.nara.jp",
    "kanmaki.nara.jp",
    "kashiba.nara.jp",
    "kashihara.nara.jp",
    "katsuragi.nara.jp",
    "kawai.nara.jp",
    "kawakami.nara.jp",
    "kawanishi.nara.jp",
    "koryo.nara.jp",
    "kurotaki.nara.jp",
    "mitsue.nara.jp",
    "miyake.nara.jp",
    "nara.nara.jp",
    "nosegawa.nara.jp",
    "oji.nara.jp",
    "ouda.nara.jp",
    "oyodo.nara.jp",
    "sakurai.nara.jp",
    "sango.nara.jp",
    "shimoichi.nara.jp",
    "shimokitayama.nara.jp",
    "shinjo.nara.jp",
    "soni.nara.jp",
    "takatori.nara.jp",
    "tawaramoto.nara.jp",
    "tenkawa.nara.jp",
    "tenri.nara.jp",
    "uda.nara.jp",
    "yamatokoriyama.nara.jp",
    "yamatotakada.nara.jp",
    "yamazoe.nara.jp",
    "yoshino.nara.jp",
    "aga.niigata.jp",
    "agano.niigata.jp",
    "gosen.niigata.jp",
    "itoigawa.niigata.jp",
    "izumozaki.niigata.jp",
    "joetsu.niigata.jp",
    "kamo.niigata.jp",
    "kariwa.niigata.jp",
    "kashiwazaki.niigata.jp",
    "minamiuonuma.niigata.jp",
    "mitsuke.niigata.jp",
    "muika.niigata.jp",
    "murakami.niigata.jp",
    "myoko.niigata.jp",
    "nagaoka.niigata.jp",
    "niigata.niigata.jp",
    "ojiya.niigata.jp",
    "omi.niigata.jp",
    "sado.niigata.jp",
    "sanjo.niigata.jp",
    "seiro.niigata.jp",
    "seirou.niigata.jp",
    "sekikawa.niigata.jp",
    "shibata.niigata.jp",
    "tagami.niigata.jp",
    "tainai.niigata.jp",
    "tochio.niigata.jp",
    "tokamachi.niigata.jp",
    "tsubame.niigata.jp",
    "tsunan.niigata.jp",
    "uonuma.niigata.jp",
    "yahiko.niigata.jp",
    "yoita.niigata.jp",
    "yuzawa.niigata.jp",
    "beppu.oita.jp",
    "bungoono.oita.jp",
    "bungotakada.oita.jp",
    "hasama.oita.jp",
    "hiji.oita.jp",
    "himeshima.oita.jp",
    "hita.oita.jp",
    "kamitsue.oita.jp",
    "kokonoe.oita.jp",
    "kuju.oita.jp",
    "kunisaki.oita.jp",
    "kusu.oita.jp",
    "oita.oita.jp",
    "saiki.oita.jp",
    "taketa.oita.jp",
    "tsukumi.oita.jp",
    "usa.oita.jp",
    "usuki.oita.jp",
    "yufu.oita.jp",
    "akaiwa.okayama.jp",
    "asakuchi.okayama.jp",
    "bizen.okayama.jp",
    "hayashima.okayama.jp",
    "ibara.okayama.jp",
    "kagamino.okayama.jp",
    "kasaoka.okayama.jp",
    "kibichuo.okayama.jp",
    "kumenan.okayama.jp",
    "kurashiki.okayama.jp",
    "maniwa.okayama.jp",
    "misaki.okayama.jp",
    "nagi.okayama.jp",
    "niimi.okayama.jp",
    "nishiawakura.okayama.jp",
    "okayama.okayama.jp",
    "satosho.okayama.jp",
    "setouchi.okayama.jp",
    "shinjo.okayama.jp",
    "shoo.okayama.jp",
    "soja.okayama.jp",
    "takahashi.okayama.jp",
    "tamano.okayama.jp",
    "tsuyama.okayama.jp",
    "wake.okayama.jp",
    "yakage.okayama.jp",
    "aguni.okinawa.jp",
    "ginowan.okinawa.jp",
    "ginoza.okinawa.jp",
    "gushikami.okinawa.jp",
    "haebaru.okinawa.jp",
    "higashi.okinawa.jp",
    "hirara.okinawa.jp",
    "iheya.okinawa.jp",
    "ishigaki.okinawa.jp",
    "ishikawa.okinawa.jp",
    "itoman.okinawa.jp",
    "izena.okinawa.jp",
    "kadena.okinawa.jp",
    "kin.okinawa.jp",
    "kitadaito.okinawa.jp",
    "kitanakagusuku.okinawa.jp",
    "kumejima.okinawa.jp",
    "kunigami.okinawa.jp",
    "minamidaito.okinawa.jp",
    "motobu.okinawa.jp",
    "nago.okinawa.jp",
    "naha.okinawa.jp",
    "nakagusuku.okinawa.jp",
    "nakijin.okinawa.jp",
    "nanjo.okinawa.jp",
    "nishihara.okinawa.jp",
    "ogimi.okinawa.jp",
    "okinawa.okinawa.jp",
    "onna.okinawa.jp",
    "shimoji.okinawa.jp",
    "taketomi.okinawa.jp",
    "tarama.okinawa.jp",
    "tokashiki.okinawa.jp",
    "tomigusuku.okinawa.jp",
    "tonaki.okinawa.jp",
    "urasoe.okinawa.jp",
    "uruma.okinawa.jp",
    "yaese.okinawa.jp",
    "yomitan.okinawa.jp",
    "yonabaru.okinawa.jp",
    "yonaguni.okinawa.jp",
    "zamami.okinawa.jp",
    "abeno.osaka.jp",
    "chihayaakasaka.osaka.jp",
    "chuo.osaka.jp",
    "daito.osaka.jp",
    "fujiidera.osaka.jp",
    "habikino.osaka.jp",
    "hannan.osaka.jp",
    "higashiosaka.osaka.jp",
    "higashisumiyoshi.osaka.jp",
    "higashiyodogawa.osaka.jp",
    "hirakata.osaka.jp",
    "ibaraki.osaka.jp",
    "ikeda.osaka.jp",
    "izumi.osaka.jp",
    "izumiotsu.osaka.jp",
    "izumisano.osaka.jp",
    "kadoma.osaka.jp",
    "kaizuka.osaka.jp",
    "kanan.osaka.jp",
    "kashiwara.osaka.jp",
    "katano.osaka.jp",
    "kawachinagano.osaka.jp",
    "kishiwada.osaka.jp",
    "kita.osaka.jp",
    "kumatori.osaka.jp",
    "matsubara.osaka.jp",
    "minato.osaka.jp",
    "minoh.osaka.jp",
    "misaki.osaka.jp",
    "moriguchi.osaka.jp",
    "neyagawa.osaka.jp",
    "nishi.osaka.jp",
    "nose.osaka.jp",
    "osakasayama.osaka.jp",
    "sakai.osaka.jp",
    "sayama.osaka.jp",
    "sennan.osaka.jp",
    "settsu.osaka.jp",
    "shijonawate.osaka.jp",
    "shimamoto.osaka.jp",
    "suita.osaka.jp",
    "tadaoka.osaka.jp",
    "taishi.osaka.jp",
    "tajiri.osaka.jp",
    "takaishi.osaka.jp",
    "takatsuki.osaka.jp",
    "tondabayashi.osaka.jp",
    "toyonaka.osaka.jp",
    "toyono.osaka.jp",
    "yao.osaka.jp",
    "ariake.saga.jp",
    "arita.saga.jp",
    "fukudomi.saga.jp",
    "genkai.saga.jp",
    "hamatama.saga.jp",
    "hizen.saga.jp",
    "imari.saga.jp",
    "kamimine.saga.jp",
    "kanzaki.saga.jp",
    "karatsu.saga.jp",
    "kashima.saga.jp",
    "kitagata.saga.jp",
    "kitahata.saga.jp",
    "kiyama.saga.jp",
    "kouhoku.saga.jp",
    "kyuragi.saga.jp",
    "nishiarita.saga.jp",
    "ogi.saga.jp",
    "omachi.saga.jp",
    "ouchi.saga.jp",
    "saga.saga.jp",
    "shiroishi.saga.jp",
    "taku.saga.jp",
    "tara.saga.jp",
    "tosu.saga.jp",
    "yoshinogari.saga.jp",
    "arakawa.saitama.jp",
    "asaka.saitama.jp",
    "chichibu.saitama.jp",
    "fujimi.saitama.jp",
    "fujimino.saitama.jp",
    "fukaya.saitama.jp",
    "hanno.saitama.jp",
    "hanyu.saitama.jp",
    "hasuda.saitama.jp",
    "hatogaya.saitama.jp",
    "hatoyama.saitama.jp",
    "hidaka.saitama.jp",
    "higashichichibu.saitama.jp",
    "higashimatsuyama.saitama.jp",
    "honjo.saitama.jp",
    "ina.saitama.jp",
    "iruma.saitama.jp",
    "iwatsuki.saitama.jp",
    "kamiizumi.saitama.jp",
    "kamikawa.saitama.jp",
    "kamisato.saitama.jp",
    "kasukabe.saitama.jp",
    "kawagoe.saitama.jp",
    "kawaguchi.saitama.jp",
    "kawajima.saitama.jp",
    "kazo.saitama.jp",
    "kitamoto.saitama.jp",
    "koshigaya.saitama.jp",
    "kounosu.saitama.jp",
    "kuki.saitama.jp",
    "kumagaya.saitama.jp",
    "matsubushi.saitama.jp",
    "minano.saitama.jp",
    "misato.saitama.jp",
    "miyashiro.saitama.jp",
    "miyoshi.saitama.jp",
    "moroyama.saitama.jp",
    "nagatoro.saitama.jp",
    "namegawa.saitama.jp",
    "niiza.saitama.jp",
    "ogano.saitama.jp",
    "ogawa.saitama.jp",
    "ogose.saitama.jp",
    "okegawa.saitama.jp",
    "omiya.saitama.jp",
    "otaki.saitama.jp",
    "ranzan.saitama.jp",
    "ryokami.saitama.jp",
    "saitama.saitama.jp",
    "sakado.saitama.jp",
    "satte.saitama.jp",
    "sayama.saitama.jp",
    "shiki.saitama.jp",
    "shiraoka.saitama.jp",
    "soka.saitama.jp",
    "sugito.saitama.jp",
    "toda.saitama.jp",
    "tokigawa.saitama.jp",
    "tokorozawa.saitama.jp",
    "tsurugashima.saitama.jp",
    "urawa.saitama.jp",
    "warabi.saitama.jp",
    "yashio.saitama.jp",
    "yokoze.saitama.jp",
    "yono.saitama.jp",
    "yorii.saitama.jp",
    "yoshida.saitama.jp",
    "yoshikawa.saitama.jp",
    "yoshimi.saitama.jp",
    "aisho.shiga.jp",
    "gamo.shiga.jp",
    "higashiomi.shiga.jp",
    "hikone.shiga.jp",
    "koka.shiga.jp",
    "konan.shiga.jp",
    "kosei.shiga.jp",
    "koto.shiga.jp",
    "kusatsu.shiga.jp",
    "maibara.shiga.jp",
    "moriyama.shiga.jp",
    "nagahama.shiga.jp",
    "nishiazai.shiga.jp",
    "notogawa.shiga.jp",
    "omihachiman.shiga.jp",
    "otsu.shiga.jp",
    "ritto.shiga.jp",
    "ryuoh.shiga.jp",
    "takashima.shiga.jp",
    "takatsuki.shiga.jp",
    "torahime.shiga.jp",
    "toyosato.shiga.jp",
    "yasu.shiga.jp",
    "akagi.shimane.jp",
    "ama.shimane.jp",
    "gotsu.shimane.jp",
    "hamada.shimane.jp",
    "higashiizumo.shimane.jp",
    "hikawa.shimane.jp",
    "hikimi.shimane.jp",
    "izumo.shimane.jp",
    "kakinoki.shimane.jp",
    "masuda.shimane.jp",
    "matsue.shimane.jp",
    "misato.shimane.jp",
    "nishinoshima.shimane.jp",
    "ohda.shimane.jp",
    "okinoshima.shimane.jp",
    "okuizumo.shimane.jp",
    "shimane.shimane.jp",
    "tamayu.shimane.jp",
    "tsuwano.shimane.jp",
    "unnan.shimane.jp",
    "yakumo.shimane.jp",
    "yasugi.shimane.jp",
    "yatsuka.shimane.jp",
    "arai.shizuoka.jp",
    "atami.shizuoka.jp",
    "fuji.shizuoka.jp",
    "fujieda.shizuoka.jp",
    "fujikawa.shizuoka.jp",
    "fujinomiya.shizuoka.jp",
    "fukuroi.shizuoka.jp",
    "gotemba.shizuoka.jp",
    "haibara.shizuoka.jp",
    "hamamatsu.shizuoka.jp",
    "higashiizu.shizuoka.jp",
    "ito.shizuoka.jp",
    "iwata.shizuoka.jp",
    "izu.shizuoka.jp",
    "izunokuni.shizuoka.jp",
    "kakegawa.shizuoka.jp",
    "kannami.shizuoka.jp",
    "kawanehon.shizuoka.jp",
    "kawazu.shizuoka.jp",
    "kikugawa.shizuoka.jp",
    "kosai.shizuoka.jp",
    "makinohara.shizuoka.jp",
    "matsuzaki.shizuoka.jp",
    "minamiizu.shizuoka.jp",
    "mishima.shizuoka.jp",
    "morimachi.shizuoka.jp",
    "nishiizu.shizuoka.jp",
    "numazu.shizuoka.jp",
    "omaezaki.shizuoka.jp",
    "shimada.shizuoka.jp",
    "shimizu.shizuoka.jp",
    "shimoda.shizuoka.jp",
    "shizuoka.shizuoka.jp",
    "susono.shizuoka.jp",
    "yaizu.shizuoka.jp",
    "yoshida.shizuoka.jp",
    "ashikaga.tochigi.jp",
    "bato.tochigi.jp",
    "haga.tochigi.jp",
    "ichikai.tochigi.jp",
    "iwafune.tochigi.jp",
    "kaminokawa.tochigi.jp",
    "kanuma.tochigi.jp",
    "karasuyama.tochigi.jp",
    "kuroiso.tochigi.jp",
    "mashiko.tochigi.jp",
    "mibu.tochigi.jp",
    "moka.tochigi.jp",
    "motegi.tochigi.jp",
    "nasu.tochigi.jp",
    "nasushiobara.tochigi.jp",
    "nikko.tochigi.jp",
    "nishikata.tochigi.jp",
    "nogi.tochigi.jp",
    "ohira.tochigi.jp",
    "ohtawara.tochigi.jp",
    "oyama.tochigi.jp",
    "sakura.tochigi.jp",
    "sano.tochigi.jp",
    "shimotsuke.tochigi.jp",
    "shioya.tochigi.jp",
    "takanezawa.tochigi.jp",
    "tochigi.tochigi.jp",
    "tsuga.tochigi.jp",
    "ujiie.tochigi.jp",
    "utsunomiya.tochigi.jp",
    "yaita.tochigi.jp",
    "aizumi.tokushima.jp",
    "anan.tokushima.jp",
    "ichiba.tokushima.jp",
    "itano.tokushima.jp",
    "kainan.tokushima.jp",
    "komatsushima.tokushima.jp",
    "matsushige.tokushima.jp",
    "mima.tokushima.jp",
    "minami.tokushima.jp",
    "miyoshi.tokushima.jp",
    "mugi.tokushima.jp",
    "nakagawa.tokushima.jp",
    "naruto.tokushima.jp",
    "sanagochi.tokushima.jp",
    "shishikui.tokushima.jp",
    "tokushima.tokushima.jp",
    "wajiki.tokushima.jp",
    "adachi.tokyo.jp",
    "akiruno.tokyo.jp",
    "akishima.tokyo.jp",
    "aogashima.tokyo.jp",
    "arakawa.tokyo.jp",
    "bunkyo.tokyo.jp",
    "chiyoda.tokyo.jp",
    "chofu.tokyo.jp",
    "chuo.tokyo.jp",
    "edogawa.tokyo.jp",
    "fuchu.tokyo.jp",
    "fussa.tokyo.jp",
    "hachijo.tokyo.jp",
    "hachioji.tokyo.jp",
    "hamura.tokyo.jp",
    "higashikurume.tokyo.jp",
    "higashimurayama.tokyo.jp",
    "higashiyamato.tokyo.jp",
    "hino.tokyo.jp",
    "hinode.tokyo.jp",
    "hinohara.tokyo.jp",
    "inagi.tokyo.jp",
    "itabashi.tokyo.jp",
    "katsushika.tokyo.jp",
    "kita.tokyo.jp",
    "kiyose.tokyo.jp",
    "kodaira.tokyo.jp",
    "koganei.tokyo.jp",
    "kokubunji.tokyo.jp",
    "komae.tokyo.jp",
    "koto.tokyo.jp",
    "kouzushima.tokyo.jp",
    "kunitachi.tokyo.jp",
    "machida.tokyo.jp",
    "meguro.tokyo.jp",
    "minato.tokyo.jp",
    "mitaka.tokyo.jp",
    "mizuho.tokyo.jp",
    "musashimurayama.tokyo.jp",
    "musashino.tokyo.jp",
    "nakano.tokyo.jp",
    "nerima.tokyo.jp",
    "ogasawara.tokyo.jp",
    "okutama.tokyo.jp",
    "ome.tokyo.jp",
    "oshima.tokyo.jp",
    "ota.tokyo.jp",
    "setagaya.tokyo.jp",
    "shibuya.tokyo.jp",
    "shinagawa.tokyo.jp",
    "shinjuku.tokyo.jp",
    "suginami.tokyo.jp",
    "sumida.tokyo.jp",
    "tachikawa.tokyo.jp",
    "taito.tokyo.jp",
    "tama.tokyo.jp",
    "toshima.tokyo.jp",
    "chizu.tottori.jp",
    "hino.tottori.jp",
    "kawahara.tottori.jp",
    "koge.tottori.jp",
    "kotoura.tottori.jp",
    "misasa.tottori.jp",
    "nanbu.tottori.jp",
    "nichinan.tottori.jp",
    "sakaiminato.tottori.jp",
    "tottori.tottori.jp",
    "wakasa.tottori.jp",
    "yazu.tottori.jp",
    "yonago.tottori.jp",
    "asahi.toyama.jp",
    "fuchu.toyama.jp",
    "fukumitsu.toyama.jp",
    "funahashi.toyama.jp",
    "himi.toyama.jp",
    "imizu.toyama.jp",
    "inami.toyama.jp",
    "johana.toyama.jp",
    "kamiichi.toyama.jp",
    "kurobe.toyama.jp",
    "nakaniikawa.toyama.jp",
    "namerikawa.toyama.jp",
    "nanto.toyama.jp",
    "nyuzen.toyama.jp",
    "oyabe.toyama.jp",
    "taira.toyama.jp",
    "takaoka.toyama.jp",
    "tateyama.toyama.jp",
    "toga.toyama.jp",
    "tonami.toyama.jp",
    "toyama.toyama.jp",
    "unazuki.toyama.jp",
    "uozu.toyama.jp",
    "yamada.toyama.jp",
    "arida.wakayama.jp",
    "aridagawa.wakayama.jp",
    "gobo.wakayama.jp",
    "hashimoto.wakayama.jp",
    "hidaka.wakayama.jp",
    "hirogawa.wakayama.jp",
    "inami.wakayama.jp",
    "iwade.wakayama.jp",
    "kainan.wakayama.jp",
    "kamitonda.wakayama.jp",
    "katsuragi.wakayama.jp",
    "kimino.wakayama.jp",
    "kinokawa.wakayama.jp",
    "kitayama.wakayama.jp",
    "koya.wakayama.jp",
    "koza.wakayama.jp",
    "kozagawa.wakayama.jp",
    "kudoyama.wakayama.jp",
    "kushimoto.wakayama.jp",
    "mihama.wakayama.jp",
    "misato.wakayama.jp",
    "nachikatsuura.wakayama.jp",
    "shingu.wakayama.jp",
    "shirahama.wakayama.jp",
    "taiji.wakayama.jp",
    "tanabe.wakayama.jp",
    "wakayama.wakayama.jp",
    "yuasa.wakayama.jp",
    "yura.wakayama.jp",
    "asahi.yamagata.jp",
    "funagata.yamagata.jp",
    "higashine.yamagata.jp",
    "iide.yamagata.jp",
    "kahoku.yamagata.jp",
    "kaminoyama.yamagata.jp",
    "kaneyama.yamagata.jp",
    "kawanishi.yamagata.jp",
    "mamurogawa.yamagata.jp",
    "mikawa.yamagata.jp",
    "murayama.yamagata.jp",
    "nagai.yamagata.jp",
    "nakayama.yamagata.jp",
    "nanyo.yamagata.jp",
    "nishikawa.yamagata.jp",
    "obanazawa.yamagata.jp",
    "oe.yamagata.jp",
    "oguni.yamagata.jp",
    "ohkura.yamagata.jp",
    "oishida.yamagata.jp",
    "sagae.yamagata.jp",
    "sakata.yamagata.jp",
    "sakegawa.yamagata.jp",
    "shinjo.yamagata.jp",
    "shirataka.yamagata.jp",
    "shonai.yamagata.jp",
    "takahata.yamagata.jp",
    "tendo.yamagata.jp",
    "tozawa.yamagata.jp",
    "tsuruoka.yamagata.jp",
    "yamagata.yamagata.jp",
    "yamanobe.yamagata.jp",
    "yonezawa.yamagata.jp",
    "yuza.yamagata.jp",
    "abu.yamaguchi.jp",
    "hagi.yamaguchi.jp",
    "hikari.yamaguchi.jp",
    "hofu.yamaguchi.jp",
    "iwakuni.yamaguchi.jp",
    "kudamatsu.yamaguchi.jp",
    "mitou.yamaguchi.jp",
    "nagato.yamaguchi.jp",
    "oshima.yamaguchi.jp",
    "shimonoseki.yamaguchi.jp",
    "shunan.yamaguchi.jp",
    "tabuse.yamaguchi.jp",
    "tokuyama.yamaguchi.jp",
    "toyota.yamaguchi.jp",
    "ube.yamaguchi.jp",
    "yuu.yamaguchi.jp",
    "chuo.yamanashi.jp",
    "doshi.yamanashi.jp",
    "fuefuki.yamanashi.jp",
    "fujikawa.yamanashi.jp",
    "fujikawaguchiko.yamanashi.jp",
    "fujiyoshida.yamanashi.jp",
    "hayakawa.yamanashi.jp",
    "hokuto.yamanashi.jp",
    "ichikawamisato.yamanashi.jp",
    "kai.yamanashi.jp",
    "kofu.yamanashi.jp",
    "koshu.yamanashi.jp",
    "kosuge.yamanashi.jp",
    "minami-alps.yamanashi.jp",
    "minobu.yamanashi.jp",
    "nakamichi.yamanashi.jp",
    "nanbu.yamanashi.jp",
    "narusawa.yamanashi.jp",
    "nirasaki.yamanashi.jp",
    "nishikatsura.yamanashi.jp",
    "oshino.yamanashi.jp",
    "otsuki.yamanashi.jp",
    "showa.yamanashi.jp",
    "tabayama.yamanashi.jp",
    "tsuru.yamanashi.jp",
    "uenohara.yamanashi.jp",
    "yamanakako.yamanashi.jp",
    "yamanashi.yamanashi.jp",
    "ke",
    "ac.ke",
    "co.ke",
    "go.ke",
    "info.ke",
    "me.ke",
    "mobi.ke",
    "ne.ke",
    "or.ke",
    "sc.ke",
    "kg",
    "org.kg",
    "net.kg",
    "com.kg",
    "edu.kg",
    "gov.kg",
    "mil.kg",
    "*.kh",
    "ki",
    "edu.ki",
    "biz.ki",
    "net.ki",
    "org.ki",
    "gov.ki",
    "info.ki",
    "com.ki",
    "km",
    "org.km",
    "nom.km",
    "gov.km",
    "prd.km",
    "tm.km",
    "edu.km",
    "mil.km",
    "ass.km",
    "com.km",
    "coop.km",
    "asso.km",
    "presse.km",
    "medecin.km",
    "notaires.km",
    "pharmaciens.km",
    "veterinaire.km",
    "gouv.km",
    "kn",
    "net.kn",
    "org.kn",
    "edu.kn",
    "gov.kn",
    "kp",
    "com.kp",
    "edu.kp",
    "gov.kp",
    "org.kp",
    "rep.kp",
    "tra.kp",
    "kr",
    "ac.kr",
    "co.kr",
    "es.kr",
    "go.kr",
    "hs.kr",
    "kg.kr",
    "mil.kr",
    "ms.kr",
    "ne.kr",
    "or.kr",
    "pe.kr",
    "re.kr",
    "sc.kr",
    "busan.kr",
    "chungbuk.kr",
    "chungnam.kr",
    "daegu.kr",
    "daejeon.kr",
    "gangwon.kr",
    "gwangju.kr",
    "gyeongbuk.kr",
    "gyeonggi.kr",
    "gyeongnam.kr",
    "incheon.kr",
    "jeju.kr",
    "jeonbuk.kr",
    "jeonnam.kr",
    "seoul.kr",
    "ulsan.kr",
    "kw",
    "com.kw",
    "edu.kw",
    "emb.kw",
    "gov.kw",
    "ind.kw",
    "net.kw",
    "org.kw",
    "ky",
    "edu.ky",
    "gov.ky",
    "com.ky",
    "org.ky",
    "net.ky",
    "kz",
    "org.kz",
    "edu.kz",
    "net.kz",
    "gov.kz",
    "mil.kz",
    "com.kz",
    "la",
    "int.la",
    "net.la",
    "info.la",
    "edu.la",
    "gov.la",
    "per.la",
    "com.la",
    "org.la",
    "lb",
    "com.lb",
    "edu.lb",
    "gov.lb",
    "net.lb",
    "org.lb",
    "lc",
    "com.lc",
    "net.lc",
    "co.lc",
    "org.lc",
    "edu.lc",
    "gov.lc",
    "li",
    "lk",
    "gov.lk",
    "sch.lk",
    "net.lk",
    "int.lk",
    "com.lk",
    "org.lk",
    "edu.lk",
    "ngo.lk",
    "soc.lk",
    "web.lk",
    "ltd.lk",
    "assn.lk",
    "grp.lk",
    "hotel.lk",
    "ac.lk",
    "lr",
    "com.lr",
    "edu.lr",
    "gov.lr",
    "org.lr",
    "net.lr",
    "ls",
    "ac.ls",
    "biz.ls",
    "co.ls",
    "edu.ls",
    "gov.ls",
    "info.ls",
    "net.ls",
    "org.ls",
    "sc.ls",
    "lt",
    "gov.lt",
    "lu",
    "lv",
    "com.lv",
    "edu.lv",
    "gov.lv",
    "org.lv",
    "mil.lv",
    "id.lv",
    "net.lv",
    "asn.lv",
    "conf.lv",
    "ly",
    "com.ly",
    "net.ly",
    "gov.ly",
    "plc.ly",
    "edu.ly",
    "sch.ly",
    "med.ly",
    "org.ly",
    "id.ly",
    "ma",
    "co.ma",
    "net.ma",
    "gov.ma",
    "org.ma",
    "ac.ma",
    "press.ma",
    "mc",
    "tm.mc",
    "asso.mc",
    "md",
    "me",
    "co.me",
    "net.me",
    "org.me",
    "edu.me",
    "ac.me",
    "gov.me",
    "its.me",
    "priv.me",
    "mg",
    "org.mg",
    "nom.mg",
    "gov.mg",
    "prd.mg",
    "tm.mg",
    "edu.mg",
    "mil.mg",
    "com.mg",
    "co.mg",
    "mh",
    "mil",
    "mk",
    "com.mk",
    "org.mk",
    "net.mk",
    "edu.mk",
    "gov.mk",
    "inf.mk",
    "name.mk",
    "ml",
    "com.ml",
    "edu.ml",
    "gouv.ml",
    "gov.ml",
    "net.ml",
    "org.ml",
    "presse.ml",
    "*.mm",
    "mn",
    "gov.mn",
    "edu.mn",
    "org.mn",
    "mo",
    "com.mo",
    "net.mo",
    "org.mo",
    "edu.mo",
    "gov.mo",
    "mobi",
    "mp",
    "mq",
    "mr",
    "gov.mr",
    "ms",
    "com.ms",
    "edu.ms",
    "gov.ms",
    "net.ms",
    "org.ms",
    "mt",
    "com.mt",
    "edu.mt",
    "net.mt",
    "org.mt",
    "mu",
    "com.mu",
    "net.mu",
    "org.mu",
    "gov.mu",
    "ac.mu",
    "co.mu",
    "or.mu",
    "museum",
    "academy.museum",
    "agriculture.museum",
    "air.museum",
    "airguard.museum",
    "alabama.museum",
    "alaska.museum",
    "amber.museum",
    "ambulance.museum",
    "american.museum",
    "americana.museum",
    "americanantiques.museum",
    "americanart.museum",
    "amsterdam.museum",
    "and.museum",
    "annefrank.museum",
    "anthro.museum",
    "anthropology.museum",
    "antiques.museum",
    "aquarium.museum",
    "arboretum.museum",
    "archaeological.museum",
    "archaeology.museum",
    "architecture.museum",
    "art.museum",
    "artanddesign.museum",
    "artcenter.museum",
    "artdeco.museum",
    "arteducation.museum",
    "artgallery.museum",
    "arts.museum",
    "artsandcrafts.museum",
    "asmatart.museum",
    "assassination.museum",
    "assisi.museum",
    "association.museum",
    "astronomy.museum",
    "atlanta.museum",
    "austin.museum",
    "australia.museum",
    "automotive.museum",
    "aviation.museum",
    "axis.museum",
    "badajoz.museum",
    "baghdad.museum",
    "bahn.museum",
    "bale.museum",
    "baltimore.museum",
    "barcelona.museum",
    "baseball.museum",
    "basel.museum",
    "baths.museum",
    "bauern.museum",
    "beauxarts.museum",
    "beeldengeluid.museum",
    "bellevue.museum",
    "bergbau.museum",
    "berkeley.museum",
    "berlin.museum",
    "bern.museum",
    "bible.museum",
    "bilbao.museum",
    "bill.museum",
    "birdart.museum",
    "birthplace.museum",
    "bonn.museum",
    "boston.museum",
    "botanical.museum",
    "botanicalgarden.museum",
    "botanicgarden.museum",
    "botany.museum",
    "brandywinevalley.museum",
    "brasil.museum",
    "bristol.museum",
    "british.museum",
    "britishcolumbia.museum",
    "broadcast.museum",
    "brunel.museum",
    "brussel.museum",
    "brussels.museum",
    "bruxelles.museum",
    "building.museum",
    "burghof.museum",
    "bus.museum",
    "bushey.museum",
    "cadaques.museum",
    "california.museum",
    "cambridge.museum",
    "can.museum",
    "canada.museum",
    "capebreton.museum",
    "carrier.museum",
    "cartoonart.museum",
    "casadelamoneda.museum",
    "castle.museum",
    "castres.museum",
    "celtic.museum",
    "center.museum",
    "chattanooga.museum",
    "cheltenham.museum",
    "chesapeakebay.museum",
    "chicago.museum",
    "children.museum",
    "childrens.museum",
    "childrensgarden.museum",
    "chiropractic.museum",
    "chocolate.museum",
    "christiansburg.museum",
    "cincinnati.museum",
    "cinema.museum",
    "circus.museum",
    "civilisation.museum",
    "civilization.museum",
    "civilwar.museum",
    "clinton.museum",
    "clock.museum",
    "coal.museum",
    "coastaldefence.museum",
    "cody.museum",
    "coldwar.museum",
    "collection.museum",
    "colonialwilliamsburg.museum",
    "coloradoplateau.museum",
    "columbia.museum",
    "columbus.museum",
    "communication.museum",
    "communications.museum",
    "community.museum",
    "computer.museum",
    "computerhistory.museum",
    "comunicações.museum",
    "contemporary.museum",
    "contemporaryart.museum",
    "convent.museum",
    "copenhagen.museum",
    "corporation.museum",
    "correios-e-telecomunicações.museum",
    "corvette.museum",
    "costume.museum",
    "countryestate.museum",
    "county.museum",
    "crafts.museum",
    "cranbrook.museum",
    "creation.museum",
    "cultural.museum",
    "culturalcenter.museum",
    "culture.museum",
    "cyber.museum",
    "cymru.museum",
    "dali.museum",
    "dallas.museum",
    "database.museum",
    "ddr.museum",
    "decorativearts.museum",
    "delaware.museum",
    "delmenhorst.museum",
    "denmark.museum",
    "depot.museum",
    "design.museum",
    "detroit.museum",
    "dinosaur.museum",
    "discovery.museum",
    "dolls.museum",
    "donostia.museum",
    "durham.museum",
    "eastafrica.museum",
    "eastcoast.museum",
    "education.museum",
    "educational.museum",
    "egyptian.museum",
    "eisenbahn.museum",
    "elburg.museum",
    "elvendrell.museum",
    "embroidery.museum",
    "encyclopedic.museum",
    "england.museum",
    "entomology.museum",
    "environment.museum",
    "environmentalconservation.museum",
    "epilepsy.museum",
    "essex.museum",
    "estate.museum",
    "ethnology.museum",
    "exeter.museum",
    "exhibition.museum",
    "family.museum",
    "farm.museum",
    "farmequipment.museum",
    "farmers.museum",
    "farmstead.museum",
    "field.museum",
    "figueres.museum",
    "filatelia.museum",
    "film.museum",
    "fineart.museum",
    "finearts.museum",
    "finland.museum",
    "flanders.museum",
    "florida.museum",
    "force.museum",
    "fortmissoula.museum",
    "fortworth.museum",
    "foundation.museum",
    "francaise.museum",
    "frankfurt.museum",
    "franziskaner.museum",
    "freemasonry.museum",
    "freiburg.museum",
    "fribourg.museum",
    "frog.museum",
    "fundacio.museum",
    "furniture.museum",
    "gallery.museum",
    "garden.museum",
    "gateway.museum",
    "geelvinck.museum",
    "gemological.museum",
    "geology.museum",
    "georgia.museum",
    "giessen.museum",
    "glas.museum",
    "glass.museum",
    "gorge.museum",
    "grandrapids.museum",
    "graz.museum",
    "guernsey.museum",
    "halloffame.museum",
    "hamburg.museum",
    "handson.museum",
    "harvestcelebration.museum",
    "hawaii.museum",
    "health.museum",
    "heimatunduhren.museum",
    "hellas.museum",
    "helsinki.museum",
    "hembygdsforbund.museum",
    "heritage.museum",
    "histoire.museum",
    "historical.museum",
    "historicalsociety.museum",
    "historichouses.museum",
    "historisch.museum",
    "historisches.museum",
    "history.museum",
    "historyofscience.museum",
    "horology.museum",
    "house.museum",
    "humanities.museum",
    "illustration.museum",
    "imageandsound.museum",
    "indian.museum",
    "indiana.museum",
    "indianapolis.museum",
    "indianmarket.museum",
    "intelligence.museum",
    "interactive.museum",
    "iraq.museum",
    "iron.museum",
    "isleofman.museum",
    "jamison.museum",
    "jefferson.museum",
    "jerusalem.museum",
    "jewelry.museum",
    "jewish.museum",
    "jewishart.museum",
    "jfk.museum",
    "journalism.museum",
    "judaica.museum",
    "judygarland.museum",
    "juedisches.museum",
    "juif.museum",
    "karate.museum",
    "karikatur.museum",
    "kids.museum",
    "koebenhavn.museum",
    "koeln.museum",
    "kunst.museum",
    "kunstsammlung.museum",
    "kunstunddesign.museum",
    "labor.museum",
    "labour.museum",
    "lajolla.museum",
    "lancashire.museum",
    "landes.museum",
    "lans.museum",
    "läns.museum",
    "larsson.museum",
    "lewismiller.museum",
    "lincoln.museum",
    "linz.museum",
    "living.museum",
    "livinghistory.museum",
    "localhistory.museum",
    "london.museum",
    "losangeles.museum",
    "louvre.museum",
    "loyalist.museum",
    "lucerne.museum",
    "luxembourg.museum",
    "luzern.museum",
    "mad.museum",
    "madrid.museum",
    "mallorca.museum",
    "manchester.museum",
    "mansion.museum",
    "mansions.museum",
    "manx.museum",
    "marburg.museum",
    "maritime.museum",
    "maritimo.museum",
    "maryland.museum",
    "marylhurst.museum",
    "media.museum",
    "medical.museum",
    "medizinhistorisches.museum",
    "meeres.museum",
    "memorial.museum",
    "mesaverde.museum",
    "michigan.museum",
    "midatlantic.museum",
    "military.museum",
    "mill.museum",
    "miners.museum",
    "mining.museum",
    "minnesota.museum",
    "missile.museum",
    "missoula.museum",
    "modern.museum",
    "moma.museum",
    "money.museum",
    "monmouth.museum",
    "monticello.museum",
    "montreal.museum",
    "moscow.museum",
    "motorcycle.museum",
    "muenchen.museum",
    "muenster.museum",
    "mulhouse.museum",
    "muncie.museum",
    "museet.museum",
    "museumcenter.museum",
    "museumvereniging.museum",
    "music.museum",
    "national.museum",
    "nationalfirearms.museum",
    "nationalheritage.museum",
    "nativeamerican.museum",
    "naturalhistory.museum",
    "naturalhistorymuseum.museum",
    "naturalsciences.museum",
    "nature.museum",
    "naturhistorisches.museum",
    "natuurwetenschappen.museum",
    "naumburg.museum",
    "naval.museum",
    "nebraska.museum",
    "neues.museum",
    "newhampshire.museum",
    "newjersey.museum",
    "newmexico.museum",
    "newport.museum",
    "newspaper.museum",
    "newyork.museum",
    "niepce.museum",
    "norfolk.museum",
    "north.museum",
    "nrw.museum",
    "nyc.museum",
    "nyny.museum",
    "oceanographic.museum",
    "oceanographique.museum",
    "omaha.museum",
    "online.museum",
    "ontario.museum",
    "openair.museum",
    "oregon.museum",
    "oregontrail.museum",
    "otago.museum",
    "oxford.museum",
    "pacific.museum",
    "paderborn.museum",
    "palace.museum",
    "paleo.museum",
    "palmsprings.museum",
    "panama.museum",
    "paris.museum",
    "pasadena.museum",
    "pharmacy.museum",
    "philadelphia.museum",
    "philadelphiaarea.museum",
    "philately.museum",
    "phoenix.museum",
    "photography.museum",
    "pilots.museum",
    "pittsburgh.museum",
    "planetarium.museum",
    "plantation.museum",
    "plants.museum",
    "plaza.museum",
    "portal.museum",
    "portland.museum",
    "portlligat.museum",
    "posts-and-telecommunications.museum",
    "preservation.museum",
    "presidio.museum",
    "press.museum",
    "project.museum",
    "public.museum",
    "pubol.museum",
    "quebec.museum",
    "railroad.museum",
    "railway.museum",
    "research.museum",
    "resistance.museum",
    "riodejaneiro.museum",
    "rochester.museum",
    "rockart.museum",
    "roma.museum",
    "russia.museum",
    "saintlouis.museum",
    "salem.museum",
    "salvadordali.museum",
    "salzburg.museum",
    "sandiego.museum",
    "sanfrancisco.museum",
    "santabarbara.museum",
    "santacruz.museum",
    "santafe.museum",
    "saskatchewan.museum",
    "satx.museum",
    "savannahga.museum",
    "schlesisches.museum",
    "schoenbrunn.museum",
    "schokoladen.museum",
    "school.museum",
    "schweiz.museum",
    "science.museum",
    "scienceandhistory.museum",
    "scienceandindustry.museum",
    "sciencecenter.museum",
    "sciencecenters.museum",
    "science-fiction.museum",
    "sciencehistory.museum",
    "sciences.museum",
    "sciencesnaturelles.museum",
    "scotland.museum",
    "seaport.museum",
    "settlement.museum",
    "settlers.museum",
    "shell.museum",
    "sherbrooke.museum",
    "sibenik.museum",
    "silk.museum",
    "ski.museum",
    "skole.museum",
    "society.museum",
    "sologne.museum",
    "soundandvision.museum",
    "southcarolina.museum",
    "southwest.museum",
    "space.museum",
    "spy.museum",
    "square.museum",
    "stadt.museum",
    "stalbans.museum",
    "starnberg.museum",
    "state.museum",
    "stateofdelaware.museum",
    "station.museum",
    "steam.museum",
    "steiermark.museum",
    "stjohn.museum",
    "stockholm.museum",
    "stpetersburg.museum",
    "stuttgart.museum",
    "suisse.museum",
    "surgeonshall.museum",
    "surrey.museum",
    "svizzera.museum",
    "sweden.museum",
    "sydney.museum",
    "tank.museum",
    "tcm.museum",
    "technology.museum",
    "telekommunikation.museum",
    "television.museum",
    "texas.museum",
    "textile.museum",
    "theater.museum",
    "time.museum",
    "timekeeping.museum",
    "topology.museum",
    "torino.museum",
    "touch.museum",
    "town.museum",
    "transport.museum",
    "tree.museum",
    "trolley.museum",
    "trust.museum",
    "trustee.museum",
    "uhren.museum",
    "ulm.museum",
    "undersea.museum",
    "university.museum",
    "usa.museum",
    "usantiques.museum",
    "usarts.museum",
    "uscountryestate.museum",
    "usculture.museum",
    "usdecorativearts.museum",
    "usgarden.museum",
    "ushistory.museum",
    "ushuaia.museum",
    "uslivinghistory.museum",
    "utah.museum",
    "uvic.museum",
    "valley.museum",
    "vantaa.museum",
    "versailles.museum",
    "viking.museum",
    "village.museum",
    "virginia.museum",
    "virtual.museum",
    "virtuel.museum",
    "vlaanderen.museum",
    "volkenkunde.museum",
    "wales.museum",
    "wallonie.museum",
    "war.museum",
    "washingtondc.museum",
    "watchandclock.museum",
    "watch-and-clock.museum",
    "western.museum",
    "westfalen.museum",
    "whaling.museum",
    "wildlife.museum",
    "williamsburg.museum",
    "windmill.museum",
    "workshop.museum",
    "york.museum",
    "yorkshire.museum",
    "yosemite.museum",
    "youth.museum",
    "zoological.museum",
    "zoology.museum",
    "ירושלים.museum",
    "иком.museum",
    "mv",
    "aero.mv",
    "biz.mv",
    "com.mv",
    "coop.mv",
    "edu.mv",
    "gov.mv",
    "info.mv",
    "int.mv",
    "mil.mv",
    "museum.mv",
    "name.mv",
    "net.mv",
    "org.mv",
    "pro.mv",
    "mw",
    "ac.mw",
    "biz.mw",
    "co.mw",
    "com.mw",
    "coop.mw",
    "edu.mw",
    "gov.mw",
    "int.mw",
    "museum.mw",
    "net.mw",
    "org.mw",
    "mx",
    "com.mx",
    "org.mx",
    "gob.mx",
    "edu.mx",
    "net.mx",
    "my",
    "com.my",
    "net.my",
    "org.my",
    "gov.my",
    "edu.my",
    "mil.my",
    "name.my",
    "mz",
    "ac.mz",
    "adv.mz",
    "co.mz",
    "edu.mz",
    "gov.mz",
    "mil.mz",
    "net.mz",
    "org.mz",
    "na",
    "info.na",
    "pro.na",
    "name.na",
    "school.na",
    "or.na",
    "dr.na",
    "us.na",
    "mx.na",
    "ca.na",
    "in.na",
    "cc.na",
    "tv.na",
    "ws.na",
    "mobi.na",
    "co.na",
    "com.na",
    "org.na",
    "name",
    "nc",
    "asso.nc",
    "nom.nc",
    "ne",
    "net",
    "nf",
    "com.nf",
    "net.nf",
    "per.nf",
    "rec.nf",
    "web.nf",
    "arts.nf",
    "firm.nf",
    "info.nf",
    "other.nf",
    "store.nf",
    "ng",
    "com.ng",
    "edu.ng",
    "gov.ng",
    "i.ng",
    "mil.ng",
    "mobi.ng",
    "name.ng",
    "net.ng",
    "org.ng",
    "sch.ng",
    "ni",
    "ac.ni",
    "biz.ni",
    "co.ni",
    "com.ni",
    "edu.ni",
    "gob.ni",
    "in.ni",
    "info.ni",
    "int.ni",
    "mil.ni",
    "net.ni",
    "nom.ni",
    "org.ni",
    "web.ni",
    "nl",
    "no",
    "fhs.no",
    "vgs.no",
    "fylkesbibl.no",
    "folkebibl.no",
    "museum.no",
    "idrett.no",
    "priv.no",
    "mil.no",
    "stat.no",
    "dep.no",
    "kommune.no",
    "herad.no",
    "aa.no",
    "ah.no",
    "bu.no",
    "fm.no",
    "hl.no",
    "hm.no",
    "jan-mayen.no",
    "mr.no",
    "nl.no",
    "nt.no",
    "of.no",
    "ol.no",
    "oslo.no",
    "rl.no",
    "sf.no",
    "st.no",
    "svalbard.no",
    "tm.no",
    "tr.no",
    "va.no",
    "vf.no",
    "gs.aa.no",
    "gs.ah.no",
    "gs.bu.no",
    "gs.fm.no",
    "gs.hl.no",
    "gs.hm.no",
    "gs.jan-mayen.no",
    "gs.mr.no",
    "gs.nl.no",
    "gs.nt.no",
    "gs.of.no",
    "gs.ol.no",
    "gs.oslo.no",
    "gs.rl.no",
    "gs.sf.no",
    "gs.st.no",
    "gs.svalbard.no",
    "gs.tm.no",
    "gs.tr.no",
    "gs.va.no",
    "gs.vf.no",
    "akrehamn.no",
    "åkrehamn.no",
    "algard.no",
    "ålgård.no",
    "arna.no",
    "brumunddal.no",
    "bryne.no",
    "bronnoysund.no",
    "brønnøysund.no",
    "drobak.no",
    "drøbak.no",
    "egersund.no",
    "fetsund.no",
    "floro.no",
    "florø.no",
    "fredrikstad.no",
    "hokksund.no",
    "honefoss.no",
    "hønefoss.no",
    "jessheim.no",
    "jorpeland.no",
    "jørpeland.no",
    "kirkenes.no",
    "kopervik.no",
    "krokstadelva.no",
    "langevag.no",
    "langevåg.no",
    "leirvik.no",
    "mjondalen.no",
    "mjøndalen.no",
    "mo-i-rana.no",
    "mosjoen.no",
    "mosjøen.no",
    "nesoddtangen.no",
    "orkanger.no",
    "osoyro.no",
    "osøyro.no",
    "raholt.no",
    "råholt.no",
    "sandnessjoen.no",
    "sandnessjøen.no",
    "skedsmokorset.no",
    "slattum.no",
    "spjelkavik.no",
    "stathelle.no",
    "stavern.no",
    "stjordalshalsen.no",
    "stjørdalshalsen.no",
    "tananger.no",
    "tranby.no",
    "vossevangen.no",
    "afjord.no",
    "åfjord.no",
    "agdenes.no",
    "al.no",
    "ål.no",
    "alesund.no",
    "ålesund.no",
    "alstahaug.no",
    "alta.no",
    "áltá.no",
    "alaheadju.no",
    "álaheadju.no",
    "alvdal.no",
    "amli.no",
    "åmli.no",
    "amot.no",
    "åmot.no",
    "andebu.no",
    "andoy.no",
    "andøy.no",
    "andasuolo.no",
    "ardal.no",
    "årdal.no",
    "aremark.no",
    "arendal.no",
    "ås.no",
    "aseral.no",
    "åseral.no",
    "asker.no",
    "askim.no",
    "askvoll.no",
    "askoy.no",
    "askøy.no",
    "asnes.no",
    "åsnes.no",
    "audnedaln.no",
    "aukra.no",
    "aure.no",
    "aurland.no",
    "aurskog-holand.no",
    "aurskog-høland.no",
    "austevoll.no",
    "austrheim.no",
    "averoy.no",
    "averøy.no",
    "balestrand.no",
    "ballangen.no",
    "balat.no",
    "bálát.no",
    "balsfjord.no",
    "bahccavuotna.no",
    "báhccavuotna.no",
    "bamble.no",
    "bardu.no",
    "beardu.no",
    "beiarn.no",
    "bajddar.no",
    "bájddar.no",
    "baidar.no",
    "báidár.no",
    "berg.no",
    "bergen.no",
    "berlevag.no",
    "berlevåg.no",
    "bearalvahki.no",
    "bearalváhki.no",
    "bindal.no",
    "birkenes.no",
    "bjarkoy.no",
    "bjarkøy.no",
    "bjerkreim.no",
    "bjugn.no",
    "bodo.no",
    "bodø.no",
    "badaddja.no",
    "bådåddjå.no",
    "budejju.no",
    "bokn.no",
    "bremanger.no",
    "bronnoy.no",
    "brønnøy.no",
    "bygland.no",
    "bykle.no",
    "barum.no",
    "bærum.no",
    "bo.telemark.no",
    "bø.telemark.no",
    "bo.nordland.no",
    "bø.nordland.no",
    "bievat.no",
    "bievát.no",
    "bomlo.no",
    "bømlo.no",
    "batsfjord.no",
    "båtsfjord.no",
    "bahcavuotna.no",
    "báhcavuotna.no",
    "dovre.no",
    "drammen.no",
    "drangedal.no",
    "dyroy.no",
    "dyrøy.no",
    "donna.no",
    "dønna.no",
    "eid.no",
    "eidfjord.no",
    "eidsberg.no",
    "eidskog.no",
    "eidsvoll.no",
    "eigersund.no",
    "elverum.no",
    "enebakk.no",
    "engerdal.no",
    "etne.no",
    "etnedal.no",
    "evenes.no",
    "evenassi.no",
    "evenášši.no",
    "evje-og-hornnes.no",
    "farsund.no",
    "fauske.no",
    "fuossko.no",
    "fuoisku.no",
    "fedje.no",
    "fet.no",
    "finnoy.no",
    "finnøy.no",
    "fitjar.no",
    "fjaler.no",
    "fjell.no",
    "flakstad.no",
    "flatanger.no",
    "flekkefjord.no",
    "flesberg.no",
    "flora.no",
    "fla.no",
    "flå.no",
    "folldal.no",
    "forsand.no",
    "fosnes.no",
    "frei.no",
    "frogn.no",
    "froland.no",
    "frosta.no",
    "frana.no",
    "fræna.no",
    "froya.no",
    "frøya.no",
    "fusa.no",
    "fyresdal.no",
    "forde.no",
    "førde.no",
    "gamvik.no",
    "gangaviika.no",
    "gáŋgaviika.no",
    "gaular.no",
    "gausdal.no",
    "gildeskal.no",
    "gildeskål.no",
    "giske.no",
    "gjemnes.no",
    "gjerdrum.no",
    "gjerstad.no",
    "gjesdal.no",
    "gjovik.no",
    "gjøvik.no",
    "gloppen.no",
    "gol.no",
    "gran.no",
    "grane.no",
    "granvin.no",
    "gratangen.no",
    "grimstad.no",
    "grong.no",
    "kraanghke.no",
    "kråanghke.no",
    "grue.no",
    "gulen.no",
    "hadsel.no",
    "halden.no",
    "halsa.no",
    "hamar.no",
    "hamaroy.no",
    "habmer.no",
    "hábmer.no",
    "hapmir.no",
    "hápmir.no",
    "hammerfest.no",
    "hammarfeasta.no",
    "hámmárfeasta.no",
    "haram.no",
    "hareid.no",
    "harstad.no",
    "hasvik.no",
    "aknoluokta.no",
    "ákŋoluokta.no",
    "hattfjelldal.no",
    "aarborte.no",
    "haugesund.no",
    "hemne.no",
    "hemnes.no",
    "hemsedal.no",
    "heroy.more-og-romsdal.no",
    "herøy.møre-og-romsdal.no",
    "heroy.nordland.no",
    "herøy.nordland.no",
    "hitra.no",
    "hjartdal.no",
    "hjelmeland.no",
    "hobol.no",
    "hobøl.no",
    "hof.no",
    "hol.no",
    "hole.no",
    "holmestrand.no",
    "holtalen.no",
    "holtålen.no",
    "hornindal.no",
    "horten.no",
    "hurdal.no",
    "hurum.no",
    "hvaler.no",
    "hyllestad.no",
    "hagebostad.no",
    "hægebostad.no",
    "hoyanger.no",
    "høyanger.no",
    "hoylandet.no",
    "høylandet.no",
    "ha.no",
    "hå.no",
    "ibestad.no",
    "inderoy.no",
    "inderøy.no",
    "iveland.no",
    "jevnaker.no",
    "jondal.no",
    "jolster.no",
    "jølster.no",
    "karasjok.no",
    "karasjohka.no",
    "kárášjohka.no",
    "karlsoy.no",
    "galsa.no",
    "gálsá.no",
    "karmoy.no",
    "karmøy.no",
    "kautokeino.no",
    "guovdageaidnu.no",
    "klepp.no",
    "klabu.no",
    "klæbu.no",
    "kongsberg.no",
    "kongsvinger.no",
    "kragero.no",
    "kragerø.no",
    "kristiansand.no",
    "kristiansund.no",
    "krodsherad.no",
    "krødsherad.no",
    "kvalsund.no",
    "rahkkeravju.no",
    "ráhkkerávju.no",
    "kvam.no",
    "kvinesdal.no",
    "kvinnherad.no",
    "kviteseid.no",
    "kvitsoy.no",
    "kvitsøy.no",
    "kvafjord.no",
    "kvæfjord.no",
    "giehtavuoatna.no",
    "kvanangen.no",
    "kvænangen.no",
    "navuotna.no",
    "návuotna.no",
    "kafjord.no",
    "kåfjord.no",
    "gaivuotna.no",
    "gáivuotna.no",
    "larvik.no",
    "lavangen.no",
    "lavagis.no",
    "loabat.no",
    "loabát.no",
    "lebesby.no",
    "davvesiida.no",
    "leikanger.no",
    "leirfjord.no",
    "leka.no",
    "leksvik.no",
    "lenvik.no",
    "leangaviika.no",
    "leaŋgaviika.no",
    "lesja.no",
    "levanger.no",
    "lier.no",
    "lierne.no",
    "lillehammer.no",
    "lillesand.no",
    "lindesnes.no",
    "lindas.no",
    "lindås.no",
    "lom.no",
    "loppa.no",
    "lahppi.no",
    "láhppi.no",
    "lund.no",
    "lunner.no",
    "luroy.no",
    "lurøy.no",
    "luster.no",
    "lyngdal.no",
    "lyngen.no",
    "ivgu.no",
    "lardal.no",
    "lerdal.no",
    "lærdal.no",
    "lodingen.no",
    "lødingen.no",
    "lorenskog.no",
    "lørenskog.no",
    "loten.no",
    "løten.no",
    "malvik.no",
    "masoy.no",
    "måsøy.no",
    "muosat.no",
    "muosát.no",
    "mandal.no",
    "marker.no",
    "marnardal.no",
    "masfjorden.no",
    "meland.no",
    "meldal.no",
    "melhus.no",
    "meloy.no",
    "meløy.no",
    "meraker.no",
    "meråker.no",
    "moareke.no",
    "moåreke.no",
    "midsund.no",
    "midtre-gauldal.no",
    "modalen.no",
    "modum.no",
    "molde.no",
    "moskenes.no",
    "moss.no",
    "mosvik.no",
    "malselv.no",
    "målselv.no",
    "malatvuopmi.no",
    "málatvuopmi.no",
    "namdalseid.no",
    "aejrie.no",
    "namsos.no",
    "namsskogan.no",
    "naamesjevuemie.no",
    "nååmesjevuemie.no",
    "laakesvuemie.no",
    "nannestad.no",
    "narvik.no",
    "narviika.no",
    "naustdal.no",
    "nedre-eiker.no",
    "nes.akershus.no",
    "nes.buskerud.no",
    "nesna.no",
    "nesodden.no",
    "nesseby.no",
    "unjarga.no",
    "unjárga.no",
    "nesset.no",
    "nissedal.no",
    "nittedal.no",
    "nord-aurdal.no",
    "nord-fron.no",
    "nord-odal.no",
    "norddal.no",
    "nordkapp.no",
    "davvenjarga.no",
    "davvenjárga.no",
    "nordre-land.no",
    "nordreisa.no",
    "raisa.no",
    "ráisa.no",
    "nore-og-uvdal.no",
    "notodden.no",
    "naroy.no",
    "nærøy.no",
    "notteroy.no",
    "nøtterøy.no",
    "odda.no",
    "oksnes.no",
    "øksnes.no",
    "oppdal.no",
    "oppegard.no",
    "oppegård.no",
    "orkdal.no",
    "orland.no",
    "ørland.no",
    "orskog.no",
    "ørskog.no",
    "orsta.no",
    "ørsta.no",
    "os.hedmark.no",
    "os.hordaland.no",
    "osen.no",
    "osteroy.no",
    "osterøy.no",
    "ostre-toten.no",
    "østre-toten.no",
    "overhalla.no",
    "ovre-eiker.no",
    "øvre-eiker.no",
    "oyer.no",
    "øyer.no",
    "oygarden.no",
    "øygarden.no",
    "oystre-slidre.no",
    "øystre-slidre.no",
    "porsanger.no",
    "porsangu.no",
    "porsáŋgu.no",
    "porsgrunn.no",
    "radoy.no",
    "radøy.no",
    "rakkestad.no",
    "rana.no",
    "ruovat.no",
    "randaberg.no",
    "rauma.no",
    "rendalen.no",
    "rennebu.no",
    "rennesoy.no",
    "rennesøy.no",
    "rindal.no",
    "ringebu.no",
    "ringerike.no",
    "ringsaker.no",
    "rissa.no",
    "risor.no",
    "risør.no",
    "roan.no",
    "rollag.no",
    "rygge.no",
    "ralingen.no",
    "rælingen.no",
    "rodoy.no",
    "rødøy.no",
    "romskog.no",
    "rømskog.no",
    "roros.no",
    "røros.no",
    "rost.no",
    "røst.no",
    "royken.no",
    "røyken.no",
    "royrvik.no",
    "røyrvik.no",
    "rade.no",
    "råde.no",
    "salangen.no",
    "siellak.no",
    "saltdal.no",
    "salat.no",
    "sálát.no",
    "sálat.no",
    "samnanger.no",
    "sande.more-og-romsdal.no",
    "sande.møre-og-romsdal.no",
    "sande.vestfold.no",
    "sandefjord.no",
    "sandnes.no",
    "sandoy.no",
    "sandøy.no",
    "sarpsborg.no",
    "sauda.no",
    "sauherad.no",
    "sel.no",
    "selbu.no",
    "selje.no",
    "seljord.no",
    "sigdal.no",
    "siljan.no",
    "sirdal.no",
    "skaun.no",
    "skedsmo.no",
    "ski.no",
    "skien.no",
    "skiptvet.no",
    "skjervoy.no",
    "skjervøy.no",
    "skierva.no",
    "skiervá.no",
    "skjak.no",
    "skjåk.no",
    "skodje.no",
    "skanland.no",
    "skånland.no",
    "skanit.no",
    "skánit.no",
    "smola.no",
    "smøla.no",
    "snillfjord.no",
    "snasa.no",
    "snåsa.no",
    "snoasa.no",
    "snaase.no",
    "snåase.no",
    "sogndal.no",
    "sokndal.no",
    "sola.no",
    "solund.no",
    "songdalen.no",
    "sortland.no",
    "spydeberg.no",
    "stange.no",
    "stavanger.no",
    "steigen.no",
    "steinkjer.no",
    "stjordal.no",
    "stjørdal.no",
    "stokke.no",
    "stor-elvdal.no",
    "stord.no",
    "stordal.no",
    "storfjord.no",
    "omasvuotna.no",
    "strand.no",
    "stranda.no",
    "stryn.no",
    "sula.no",
    "suldal.no",
    "sund.no",
    "sunndal.no",
    "surnadal.no",
    "sveio.no",
    "svelvik.no",
    "sykkylven.no",
    "sogne.no",
    "søgne.no",
    "somna.no",
    "sømna.no",
    "sondre-land.no",
    "søndre-land.no",
    "sor-aurdal.no",
    "sør-aurdal.no",
    "sor-fron.no",
    "sør-fron.no",
    "sor-odal.no",
    "sør-odal.no",
    "sor-varanger.no",
    "sør-varanger.no",
    "matta-varjjat.no",
    "mátta-várjjat.no",
    "sorfold.no",
    "sørfold.no",
    "sorreisa.no",
    "sørreisa.no",
    "sorum.no",
    "sørum.no",
    "tana.no",
    "deatnu.no",
    "time.no",
    "tingvoll.no",
    "tinn.no",
    "tjeldsund.no",
    "dielddanuorri.no",
    "tjome.no",
    "tjøme.no",
    "tokke.no",
    "tolga.no",
    "torsken.no",
    "tranoy.no",
    "tranøy.no",
    "tromso.no",
    "tromsø.no",
    "tromsa.no",
    "romsa.no",
    "trondheim.no",
    "troandin.no",
    "trysil.no",
    "trana.no",
    "træna.no",
    "trogstad.no",
    "trøgstad.no",
    "tvedestrand.no",
    "tydal.no",
    "tynset.no",
    "tysfjord.no",
    "divtasvuodna.no",
    "divttasvuotna.no",
    "tysnes.no",
    "tysvar.no",
    "tysvær.no",
    "tonsberg.no",
    "tønsberg.no",
    "ullensaker.no",
    "ullensvang.no",
    "ulvik.no",
    "utsira.no",
    "vadso.no",
    "vadsø.no",
    "cahcesuolo.no",
    "čáhcesuolo.no",
    "vaksdal.no",
    "valle.no",
    "vang.no",
    "vanylven.no",
    "vardo.no",
    "vardø.no",
    "varggat.no",
    "várggát.no",
    "vefsn.no",
    "vaapste.no",
    "vega.no",
    "vegarshei.no",
    "vegårshei.no",
    "vennesla.no",
    "verdal.no",
    "verran.no",
    "vestby.no",
    "vestnes.no",
    "vestre-slidre.no",
    "vestre-toten.no",
    "vestvagoy.no",
    "vestvågøy.no",
    "vevelstad.no",
    "vik.no",
    "vikna.no",
    "vindafjord.no",
    "volda.no",
    "voss.no",
    "varoy.no",
    "værøy.no",
    "vagan.no",
    "vågan.no",
    "voagat.no",
    "vagsoy.no",
    "vågsøy.no",
    "vaga.no",
    "vågå.no",
    "valer.ostfold.no",
    "våler.østfold.no",
    "valer.hedmark.no",
    "våler.hedmark.no",
    "*.np",
    "nr",
    "biz.nr",
    "info.nr",
    "gov.nr",
    "edu.nr",
    "org.nr",
    "net.nr",
    "com.nr",
    "nu",
    "nz",
    "ac.nz",
    "co.nz",
    "cri.nz",
    "geek.nz",
    "gen.nz",
    "govt.nz",
    "health.nz",
    "iwi.nz",
    "kiwi.nz",
    "maori.nz",
    "mil.nz",
    "māori.nz",
    "net.nz",
    "org.nz",
    "parliament.nz",
    "school.nz",
    "om",
    "co.om",
    "com.om",
    "edu.om",
    "gov.om",
    "med.om",
    "museum.om",
    "net.om",
    "org.om",
    "pro.om",
    "onion",
    "org",
    "pa",
    "ac.pa",
    "gob.pa",
    "com.pa",
    "org.pa",
    "sld.pa",
    "edu.pa",
    "net.pa",
    "ing.pa",
    "abo.pa",
    "med.pa",
    "nom.pa",
    "pe",
    "edu.pe",
    "gob.pe",
    "nom.pe",
    "mil.pe",
    "org.pe",
    "com.pe",
    "net.pe",
    "pf",
    "com.pf",
    "org.pf",
    "edu.pf",
    "*.pg",
    "ph",
    "com.ph",
    "net.ph",
    "org.ph",
    "gov.ph",
    "edu.ph",
    "ngo.ph",
    "mil.ph",
    "i.ph",
    "pk",
    "com.pk",
    "net.pk",
    "edu.pk",
    "org.pk",
    "fam.pk",
    "biz.pk",
    "web.pk",
    "gov.pk",
    "gob.pk",
    "gok.pk",
    "gon.pk",
    "gop.pk",
    "gos.pk",
    "info.pk",
    "pl",
    "com.pl",
    "net.pl",
    "org.pl",
    "aid.pl",
    "agro.pl",
    "atm.pl",
    "auto.pl",
    "biz.pl",
    "edu.pl",
    "gmina.pl",
    "gsm.pl",
    "info.pl",
    "mail.pl",
    "miasta.pl",
    "media.pl",
    "mil.pl",
    "nieruchomosci.pl",
    "nom.pl",
    "pc.pl",
    "powiat.pl",
    "priv.pl",
    "realestate.pl",
    "rel.pl",
    "sex.pl",
    "shop.pl",
    "sklep.pl",
    "sos.pl",
    "szkola.pl",
    "targi.pl",
    "tm.pl",
    "tourism.pl",
    "travel.pl",
    "turystyka.pl",
    "gov.pl",
    "ap.gov.pl",
    "ic.gov.pl",
    "is.gov.pl",
    "us.gov.pl",
    "kmpsp.gov.pl",
    "kppsp.gov.pl",
    "kwpsp.gov.pl",
    "psp.gov.pl",
    "wskr.gov.pl",
    "kwp.gov.pl",
    "mw.gov.pl",
    "ug.gov.pl",
    "um.gov.pl",
    "umig.gov.pl",
    "ugim.gov.pl",
    "upow.gov.pl",
    "uw.gov.pl",
    "starostwo.gov.pl",
    "pa.gov.pl",
    "po.gov.pl",
    "psse.gov.pl",
    "pup.gov.pl",
    "rzgw.gov.pl",
    "sa.gov.pl",
    "so.gov.pl",
    "sr.gov.pl",
    "wsa.gov.pl",
    "sko.gov.pl",
    "uzs.gov.pl",
    "wiih.gov.pl",
    "winb.gov.pl",
    "pinb.gov.pl",
    "wios.gov.pl",
    "witd.gov.pl",
    "wzmiuw.gov.pl",
    "piw.gov.pl",
    "wiw.gov.pl",
    "griw.gov.pl",
    "wif.gov.pl",
    "oum.gov.pl",
    "sdn.gov.pl",
    "zp.gov.pl",
    "uppo.gov.pl",
    "mup.gov.pl",
    "wuoz.gov.pl",
    "konsulat.gov.pl",
    "oirm.gov.pl",
    "augustow.pl",
    "babia-gora.pl",
    "bedzin.pl",
    "beskidy.pl",
    "bialowieza.pl",
    "bialystok.pl",
    "bielawa.pl",
    "bieszczady.pl",
    "boleslawiec.pl",
    "bydgoszcz.pl",
    "bytom.pl",
    "cieszyn.pl",
    "czeladz.pl",
    "czest.pl",
    "dlugoleka.pl",
    "elblag.pl",
    "elk.pl",
    "glogow.pl",
    "gniezno.pl",
    "gorlice.pl",
    "grajewo.pl",
    "ilawa.pl",
    "jaworzno.pl",
    "jelenia-gora.pl",
    "jgora.pl",
    "kalisz.pl",
    "kazimierz-dolny.pl",
    "karpacz.pl",
    "kartuzy.pl",
    "kaszuby.pl",
    "katowice.pl",
    "kepno.pl",
    "ketrzyn.pl",
    "klodzko.pl",
    "kobierzyce.pl",
    "kolobrzeg.pl",
    "konin.pl",
    "konskowola.pl",
    "kutno.pl",
    "lapy.pl",
    "lebork.pl",
    "legnica.pl",
    "lezajsk.pl",
    "limanowa.pl",
    "lomza.pl",
    "lowicz.pl",
    "lubin.pl",
    "lukow.pl",
    "malbork.pl",
    "malopolska.pl",
    "mazowsze.pl",
    "mazury.pl",
    "mielec.pl",
    "mielno.pl",
    "mragowo.pl",
    "naklo.pl",
    "nowaruda.pl",
    "nysa.pl",
    "olawa.pl",
    "olecko.pl",
    "olkusz.pl",
    "olsztyn.pl",
    "opoczno.pl",
    "opole.pl",
    "ostroda.pl",
    "ostroleka.pl",
    "ostrowiec.pl",
    "ostrowwlkp.pl",
    "pila.pl",
    "pisz.pl",
    "podhale.pl",
    "podlasie.pl",
    "polkowice.pl",
    "pomorze.pl",
    "pomorskie.pl",
    "prochowice.pl",
    "pruszkow.pl",
    "przeworsk.pl",
    "pulawy.pl",
    "radom.pl",
    "rawa-maz.pl",
    "rybnik.pl",
    "rzeszow.pl",
    "sanok.pl",
    "sejny.pl",
    "slask.pl",
    "slupsk.pl",
    "sosnowiec.pl",
    "stalowa-wola.pl",
    "skoczow.pl",
    "starachowice.pl",
    "stargard.pl",
    "suwalki.pl",
    "swidnica.pl",
    "swiebodzin.pl",
    "swinoujscie.pl",
    "szczecin.pl",
    "szczytno.pl",
    "tarnobrzeg.pl",
    "tgory.pl",
    "turek.pl",
    "tychy.pl",
    "ustka.pl",
    "walbrzych.pl",
    "warmia.pl",
    "warszawa.pl",
    "waw.pl",
    "wegrow.pl",
    "wielun.pl",
    "wlocl.pl",
    "wloclawek.pl",
    "wodzislaw.pl",
    "wolomin.pl",
    "wroclaw.pl",
    "zachpomor.pl",
    "zagan.pl",
    "zarow.pl",
    "zgora.pl",
    "zgorzelec.pl",
    "pm",
    "pn",
    "gov.pn",
    "co.pn",
    "org.pn",
    "edu.pn",
    "net.pn",
    "post",
    "pr",
    "com.pr",
    "net.pr",
    "org.pr",
    "gov.pr",
    "edu.pr",
    "isla.pr",
    "pro.pr",
    "biz.pr",
    "info.pr",
    "name.pr",
    "est.pr",
    "prof.pr",
    "ac.pr",
    "pro",
    "aaa.pro",
    "aca.pro",
    "acct.pro",
    "avocat.pro",
    "bar.pro",
    "cpa.pro",
    "eng.pro",
    "jur.pro",
    "law.pro",
    "med.pro",
    "recht.pro",
    "ps",
    "edu.ps",
    "gov.ps",
    "sec.ps",
    "plo.ps",
    "com.ps",
    "org.ps",
    "net.ps",
    "pt",
    "net.pt",
    "gov.pt",
    "org.pt",
    "edu.pt",
    "int.pt",
    "publ.pt",
    "com.pt",
    "nome.pt",
    "pw",
    "co.pw",
    "ne.pw",
    "or.pw",
    "ed.pw",
    "go.pw",
    "belau.pw",
    "py",
    "com.py",
    "coop.py",
    "edu.py",
    "gov.py",
    "mil.py",
    "net.py",
    "org.py",
    "qa",
    "com.qa",
    "edu.qa",
    "gov.qa",
    "mil.qa",
    "name.qa",
    "net.qa",
    "org.qa",
    "sch.qa",
    "re",
    "asso.re",
    "com.re",
    "nom.re",
    "ro",
    "arts.ro",
    "com.ro",
    "firm.ro",
    "info.ro",
    "nom.ro",
    "nt.ro",
    "org.ro",
    "rec.ro",
    "store.ro",
    "tm.ro",
    "www.ro",
    "rs",
    "ac.rs",
    "co.rs",
    "edu.rs",
    "gov.rs",
    "in.rs",
    "org.rs",
    "ru",
    "ac.ru",
    "edu.ru",
    "gov.ru",
    "int.ru",
    "mil.ru",
    "test.ru",
    "rw",
    "ac.rw",
    "co.rw",
    "coop.rw",
    "gov.rw",
    "mil.rw",
    "net.rw",
    "org.rw",
    "sa",
    "com.sa",
    "net.sa",
    "org.sa",
    "gov.sa",
    "med.sa",
    "pub.sa",
    "edu.sa",
    "sch.sa",
    "sb",
    "com.sb",
    "edu.sb",
    "gov.sb",
    "net.sb",
    "org.sb",
    "sc",
    "com.sc",
    "gov.sc",
    "net.sc",
    "org.sc",
    "edu.sc",
    "sd",
    "com.sd",
    "net.sd",
    "org.sd",
    "edu.sd",
    "med.sd",
    "tv.sd",
    "gov.sd",
    "info.sd",
    "se",
    "a.se",
    "ac.se",
    "b.se",
    "bd.se",
    "brand.se",
    "c.se",
    "d.se",
    "e.se",
    "f.se",
    "fh.se",
    "fhsk.se",
    "fhv.se",
    "g.se",
    "h.se",
    "i.se",
    "k.se",
    "komforb.se",
    "kommunalforbund.se",
    "komvux.se",
    "l.se",
    "lanbib.se",
    "m.se",
    "n.se",
    "naturbruksgymn.se",
    "o.se",
    "org.se",
    "p.se",
    "parti.se",
    "pp.se",
    "press.se",
    "r.se",
    "s.se",
    "t.se",
    "tm.se",
    "u.se",
    "w.se",
    "x.se",
    "y.se",
    "z.se",
    "sg",
    "com.sg",
    "net.sg",
    "org.sg",
    "gov.sg",
    "edu.sg",
    "per.sg",
    "sh",
    "com.sh",
    "net.sh",
    "gov.sh",
    "org.sh",
    "mil.sh",
    "si",
    "sj",
    "sk",
    "sl",
    "com.sl",
    "net.sl",
    "edu.sl",
    "gov.sl",
    "org.sl",
    "sm",
    "sn",
    "art.sn",
    "com.sn",
    "edu.sn",
    "gouv.sn",
    "org.sn",
    "perso.sn",
    "univ.sn",
    "so",
    "com.so",
    "net.so",
    "org.so",
    "sr",
    "ss",
    "biz.ss",
    "com.ss",
    "edu.ss",
    "gov.ss",
    "net.ss",
    "org.ss",
    "st",
    "co.st",
    "com.st",
    "consulado.st",
    "edu.st",
    "embaixada.st",
    "gov.st",
    "mil.st",
    "net.st",
    "org.st",
    "principe.st",
    "saotome.st",
    "store.st",
    "su",
    "sv",
    "com.sv",
    "edu.sv",
    "gob.sv",
    "org.sv",
    "red.sv",
    "sx",
    "gov.sx",
    "sy",
    "edu.sy",
    "gov.sy",
    "net.sy",
    "mil.sy",
    "com.sy",
    "org.sy",
    "sz",
    "co.sz",
    "ac.sz",
    "org.sz",
    "tc",
    "td",
    "tel",
    "tf",
    "tg",
    "th",
    "ac.th",
    "co.th",
    "go.th",
    "in.th",
    "mi.th",
    "net.th",
    "or.th",
    "tj",
    "ac.tj",
    "biz.tj",
    "co.tj",
    "com.tj",
    "edu.tj",
    "go.tj",
    "gov.tj",
    "int.tj",
    "mil.tj",
    "name.tj",
    "net.tj",
    "nic.tj",
    "org.tj",
    "test.tj",
    "web.tj",
    "tk",
    "tl",
    "gov.tl",
    "tm",
    "com.tm",
    "co.tm",
    "org.tm",
    "net.tm",
    "nom.tm",
    "gov.tm",
    "mil.tm",
    "edu.tm",
    "tn",
    "com.tn",
    "ens.tn",
    "fin.tn",
    "gov.tn",
    "ind.tn",
    "intl.tn",
    "nat.tn",
    "net.tn",
    "org.tn",
    "info.tn",
    "perso.tn",
    "tourism.tn",
    "edunet.tn",
    "rnrt.tn",
    "rns.tn",
    "rnu.tn",
    "mincom.tn",
    "agrinet.tn",
    "defense.tn",
    "turen.tn",
    "to",
    "com.to",
    "gov.to",
    "net.to",
    "org.to",
    "edu.to",
    "mil.to",
    "tr",
    "av.tr",
    "bbs.tr",
    "bel.tr",
    "biz.tr",
    "com.tr",
    "dr.tr",
    "edu.tr",
    "gen.tr",
    "gov.tr",
    "info.tr",
    "mil.tr",
    "k12.tr",
    "kep.tr",
    "name.tr",
    "net.tr",
    "org.tr",
    "pol.tr",
    "tel.tr",
    "tsk.tr",
    "tv.tr",
    "web.tr",
    "nc.tr",
    "gov.nc.tr",
    "tt",
    "co.tt",
    "com.tt",
    "org.tt",
    "net.tt",
    "biz.tt",
    "info.tt",
    "pro.tt",
    "int.tt",
    "coop.tt",
    "jobs.tt",
    "mobi.tt",
    "travel.tt",
    "museum.tt",
    "aero.tt",
    "name.tt",
    "gov.tt",
    "edu.tt",
    "tv",
    "tw",
    "edu.tw",
    "gov.tw",
    "mil.tw",
    "com.tw",
    "net.tw",
    "org.tw",
    "idv.tw",
    "game.tw",
    "ebiz.tw",
    "club.tw",
    "網路.tw",
    "組織.tw",
    "商業.tw",
    "tz",
    "ac.tz",
    "co.tz",
    "go.tz",
    "hotel.tz",
    "info.tz",
    "me.tz",
    "mil.tz",
    "mobi.tz",
    "ne.tz",
    "or.tz",
    "sc.tz",
    "tv.tz",
    "ua",
    "com.ua",
    "edu.ua",
    "gov.ua",
    "in.ua",
    "net.ua",
    "org.ua",
    "cherkassy.ua",
    "cherkasy.ua",
    "chernigov.ua",
    "chernihiv.ua",
    "chernivtsi.ua",
    "chernovtsy.ua",
    "ck.ua",
    "cn.ua",
    "cr.ua",
    "crimea.ua",
    "cv.ua",
    "dn.ua",
    "dnepropetrovsk.ua",
    "dnipropetrovsk.ua",
    "dominic.ua",
    "donetsk.ua",
    "dp.ua",
    "if.ua",
    "ivano-frankivsk.ua",
    "kh.ua",
    "kharkiv.ua",
    "kharkov.ua",
    "kherson.ua",
    "khmelnitskiy.ua",
    "khmelnytskyi.ua",
    "kiev.ua",
    "kirovograd.ua",
    "km.ua",
    "kr.ua",
    "krym.ua",
    "ks.ua",
    "kv.ua",
    "kyiv.ua",
    "lg.ua",
    "lt.ua",
    "lugansk.ua",
    "lutsk.ua",
    "lv.ua",
    "lviv.ua",
    "mk.ua",
    "mykolaiv.ua",
    "nikolaev.ua",
    "od.ua",
    "odesa.ua",
    "odessa.ua",
    "pl.ua",
    "poltava.ua",
    "rivne.ua",
    "rovno.ua",
    "rv.ua",
    "sb.ua",
    "sebastopol.ua",
    "sevastopol.ua",
    "sm.ua",
    "sumy.ua",
    "te.ua",
    "ternopil.ua",
    "uz.ua",
    "uzhgorod.ua",
    "vinnica.ua",
    "vinnytsia.ua",
    "vn.ua",
    "volyn.ua",
    "yalta.ua",
    "zaporizhzhe.ua",
    "zaporizhzhia.ua",
    "zhitomir.ua",
    "zhytomyr.ua",
    "zp.ua",
    "zt.ua",
    "ug",
    "co.ug",
    "or.ug",
    "ac.ug",
    "sc.ug",
    "go.ug",
    "ne.ug",
    "com.ug",
    "org.ug",
    "uk",
    "ac.uk",
    "co.uk",
    "gov.uk",
    "ltd.uk",
    "me.uk",
    "net.uk",
    "nhs.uk",
    "org.uk",
    "plc.uk",
    "police.uk",
    "*.sch.uk",
    "us",
    "dni.us",
    "fed.us",
    "isa.us",
    "kids.us",
    "nsn.us",
    "ak.us",
    "al.us",
    "ar.us",
    "as.us",
    "az.us",
    "ca.us",
    "co.us",
    "ct.us",
    "dc.us",
    "de.us",
    "fl.us",
    "ga.us",
    "gu.us",
    "hi.us",
    "ia.us",
    "id.us",
    "il.us",
    "in.us",
    "ks.us",
    "ky.us",
    "la.us",
    "ma.us",
    "md.us",
    "me.us",
    "mi.us",
    "mn.us",
    "mo.us",
    "ms.us",
    "mt.us",
    "nc.us",
    "nd.us",
    "ne.us",
    "nh.us",
    "nj.us",
    "nm.us",
    "nv.us",
    "ny.us",
    "oh.us",
    "ok.us",
    "or.us",
    "pa.us",
    "pr.us",
    "ri.us",
    "sc.us",
    "sd.us",
    "tn.us",
    "tx.us",
    "ut.us",
    "vi.us",
    "vt.us",
    "va.us",
    "wa.us",
    "wi.us",
    "wv.us",
    "wy.us",
    "k12.ak.us",
    "k12.al.us",
    "k12.ar.us",
    "k12.as.us",
    "k12.az.us",
    "k12.ca.us",
    "k12.co.us",
    "k12.ct.us",
    "k12.dc.us",
    "k12.de.us",
    "k12.fl.us",
    "k12.ga.us",
    "k12.gu.us",
    "k12.ia.us",
    "k12.id.us",
    "k12.il.us",
    "k12.in.us",
    "k12.ks.us",
    "k12.ky.us",
    "k12.la.us",
    "k12.ma.us",
    "k12.md.us",
    "k12.me.us",
    "k12.mi.us",
    "k12.mn.us",
    "k12.mo.us",
    "k12.ms.us",
    "k12.mt.us",
    "k12.nc.us",
    "k12.ne.us",
    "k12.nh.us",
    "k12.nj.us",
    "k12.nm.us",
    "k12.nv.us",
    "k12.ny.us",
    "k12.oh.us",
    "k12.ok.us",
    "k12.or.us",
    "k12.pa.us",
    "k12.pr.us",
    "k12.ri.us",
    "k12.sc.us",
    "k12.tn.us",
    "k12.tx.us",
    "k12.ut.us",
    "k12.vi.us",
    "k12.vt.us",
    "k12.va.us",
    "k12.wa.us",
    "k12.wi.us",
    "k12.wy.us",
    "cc.ak.us",
    "cc.al.us",
    "cc.ar.us",
    "cc.as.us",
    "cc.az.us",
    "cc.ca.us",
    "cc.co.us",
    "cc.ct.us",
    "cc.dc.us",
    "cc.de.us",
    "cc.fl.us",
    "cc.ga.us",
    "cc.gu.us",
    "cc.hi.us",
    "cc.ia.us",
    "cc.id.us",
    "cc.il.us",
    "cc.in.us",
    "cc.ks.us",
    "cc.ky.us",
    "cc.la.us",
    "cc.ma.us",
    "cc.md.us",
    "cc.me.us",
    "cc.mi.us",
    "cc.mn.us",
    "cc.mo.us",
    "cc.ms.us",
    "cc.mt.us",
    "cc.nc.us",
    "cc.nd.us",
    "cc.ne.us",
    "cc.nh.us",
    "cc.nj.us",
    "cc.nm.us",
    "cc.nv.us",
    "cc.ny.us",
    "cc.oh.us",
    "cc.ok.us",
    "cc.or.us",
    "cc.pa.us",
    "cc.pr.us",
    "cc.ri.us",
    "cc.sc.us",
    "cc.sd.us",
    "cc.tn.us",
    "cc.tx.us",
    "cc.ut.us",
    "cc.vi.us",
    "cc.vt.us",
    "cc.va.us",
    "cc.wa.us",
    "cc.wi.us",
    "cc.wv.us",
    "cc.wy.us",
    "lib.ak.us",
    "lib.al.us",
    "lib.ar.us",
    "lib.as.us",
    "lib.az.us",
    "lib.ca.us",
    "lib.co.us",
    "lib.ct.us",
    "lib.dc.us",
    "lib.fl.us",
    "lib.ga.us",
    "lib.gu.us",
    "lib.hi.us",
    "lib.ia.us",
    "lib.id.us",
    "lib.il.us",
    "lib.in.us",
    "lib.ks.us",
    "lib.ky.us",
    "lib.la.us",
    "lib.ma.us",
    "lib.md.us",
    "lib.me.us",
    "lib.mi.us",
    "lib.mn.us",
    "lib.mo.us",
    "lib.ms.us",
    "lib.mt.us",
    "lib.nc.us",
    "lib.nd.us",
    "lib.ne.us",
    "lib.nh.us",
    "lib.nj.us",
    "lib.nm.us",
    "lib.nv.us",
    "lib.ny.us",
    "lib.oh.us",
    "lib.ok.us",
    "lib.or.us",
    "lib.pa.us",
    "lib.pr.us",
    "lib.ri.us",
    "lib.sc.us",
    "lib.sd.us",
    "lib.tn.us",
    "lib.tx.us",
    "lib.ut.us",
    "lib.vi.us",
    "lib.vt.us",
    "lib.va.us",
    "lib.wa.us",
    "lib.wi.us",
    "lib.wy.us",
    "pvt.k12.ma.us",
    "chtr.k12.ma.us",
    "paroch.k12.ma.us",
    "ann-arbor.mi.us",
    "cog.mi.us",
    "dst.mi.us",
    "eaton.mi.us",
    "gen.mi.us",
    "mus.mi.us",
    "tec.mi.us",
    "washtenaw.mi.us",
    "uy",
    "com.uy",
    "edu.uy",
    "gub.uy",
    "mil.uy",
    "net.uy",
    "org.uy",
    "uz",
    "co.uz",
    "com.uz",
    "net.uz",
    "org.uz",
    "va",
    "vc",
    "com.vc",
    "net.vc",
    "org.vc",
    "gov.vc",
    "mil.vc",
    "edu.vc",
    "ve",
    "arts.ve",
    "co.ve",
    "com.ve",
    "e12.ve",
    "edu.ve",
    "firm.ve",
    "gob.ve",
    "gov.ve",
    "info.ve",
    "int.ve",
    "mil.ve",
    "net.ve",
    "org.ve",
    "rec.ve",
    "store.ve",
    "tec.ve",
    "web.ve",
    "vg",
    "vi",
    "co.vi",
    "com.vi",
    "k12.vi",
    "net.vi",
    "org.vi",
    "vn",
    "com.vn",
    "net.vn",
    "org.vn",
    "edu.vn",
    "gov.vn",
    "int.vn",
    "ac.vn",
    "biz.vn",
    "info.vn",
    "name.vn",
    "pro.vn",
    "health.vn",
    "vu",
    "com.vu",
    "edu.vu",
    "net.vu",
    "org.vu",
    "wf",
    "ws",
    "com.ws",
    "net.ws",
    "org.ws",
    "gov.ws",
    "edu.ws",
    "yt",
    "امارات",
    "հայ",
    "বাংলা",
    "бг",
    "бел",
    "中国",
    "中國",
    "الجزائر",
    "مصر",
    "ею",
    "موريتانيا",
    "გე",
    "ελ",
    "香港",
    "公司.香港",
    "教育.香港",
    "政府.香港",
    "個人.香港",
    "網絡.香港",
    "組織.香港",
    "ಭಾರತ",
    "ଭାରତ",
    "ভাৰত",
    "भारतम्",
    "भारोत",
    "ڀارت",
    "ഭാരതം",
    "भारत",
    "بارت",
    "بھارت",
    "భారత్",
    "ભારત",
    "ਭਾਰਤ",
    "ভারত",
    "இந்தியா",
    "ایران",
    "ايران",
    "عراق",
    "الاردن",
    "한국",
    "қаз",
    "ලංකා",
    "இலங்கை",
    "المغرب",
    "мкд",
    "мон",
    "澳門",
    "澳门",
    "مليسيا",
    "عمان",
    "پاکستان",
    "پاكستان",
    "فلسطين",
    "срб",
    "пр.срб",
    "орг.срб",
    "обр.срб",
    "од.срб",
    "упр.срб",
    "ак.срб",
    "рф",
    "قطر",
    "السعودية",
    "السعودیة",
    "السعودیۃ",
    "السعوديه",
    "سودان",
    "新加坡",
    "சிங்கப்பூர்",
    "سورية",
    "سوريا",
    "ไทย",
    "ศึกษา.ไทย",
    "ธุรกิจ.ไทย",
    "รัฐบาล.ไทย",
    "ทหาร.ไทย",
    "เน็ต.ไทย",
    "องค์กร.ไทย",
    "تونس",
    "台灣",
    "台湾",
    "臺灣",
    "укр",
    "اليمن",
    "xxx",
    "*.ye",
    "ac.za",
    "agric.za",
    "alt.za",
    "co.za",
    "edu.za",
    "gov.za",
    "grondar.za",
    "law.za",
    "mil.za",
    "net.za",
    "ngo.za",
    "nic.za",
    "nis.za",
    "nom.za",
    "org.za",
    "school.za",
    "tm.za",
    "web.za",
    "zm",
    "ac.zm",
    "biz.zm",
    "co.zm",
    "com.zm",
    "edu.zm",
    "gov.zm",
    "info.zm",
    "mil.zm",
    "net.zm",
    "org.zm",
    "sch.zm",
    "zw",
    "ac.zw",
    "co.zw",
    "gov.zw",
    "mil.zw",
    "org.zw",
    "aaa",
    "aarp",
    "abarth",
    "abb",
    "abbott",
    "abbvie",
    "abc",
    "able",
    "abogado",
    "abudhabi",
    "academy",
    "accenture",
    "accountant",
    "accountants",
    "aco",
    "actor",
    "adac",
    "ads",
    "adult",
    "aeg",
    "aetna",
    "afamilycompany",
    "afl",
    "africa",
    "agakhan",
    "agency",
    "aig",
    "aigo",
    "airbus",
    "airforce",
    "airtel",
    "akdn",
    "alfaromeo",
    "alibaba",
    "alipay",
    "allfinanz",
    "allstate",
    "ally",
    "alsace",
    "alstom",
    "americanexpress",
    "americanfamily",
    "amex",
    "amfam",
    "amica",
    "amsterdam",
    "analytics",
    "android",
    "anquan",
    "anz",
    "aol",
    "apartments",
    "app",
    "apple",
    "aquarelle",
    "arab",
    "aramco",
    "archi",
    "army",
    "art",
    "arte",
    "asda",
    "associates",
    "athleta",
    "attorney",
    "auction",
    "audi",
    "audible",
    "audio",
    "auspost",
    "author",
    "auto",
    "autos",
    "avianca",
    "aws",
    "axa",
    "azure",
    "baby",
    "baidu",
    "banamex",
    "bananarepublic",
    "band",
    "bank",
    "bar",
    "barcelona",
    "barclaycard",
    "barclays",
    "barefoot",
    "bargains",
    "baseball",
    "basketball",
    "bauhaus",
    "bayern",
    "bbc",
    "bbt",
    "bbva",
    "bcg",
    "bcn",
    "beats",
    "beauty",
    "beer",
    "bentley",
    "berlin",
    "best",
    "bestbuy",
    "bet",
    "bharti",
    "bible",
    "bid",
    "bike",
    "bing",
    "bingo",
    "bio",
    "black",
    "blackfriday",
    "blockbuster",
    "blog",
    "bloomberg",
    "blue",
    "bms",
    "bmw",
    "bnpparibas",
    "boats",
    "boehringer",
    "bofa",
    "bom",
    "bond",
    "boo",
    "book",
    "booking",
    "bosch",
    "bostik",
    "boston",
    "bot",
    "boutique",
    "box",
    "bradesco",
    "bridgestone",
    "broadway",
    "broker",
    "brother",
    "brussels",
    "budapest",
    "bugatti",
    "build",
    "builders",
    "business",
    "buy",
    "buzz",
    "bzh",
    "cab",
    "cafe",
    "cal",
    "call",
    "calvinklein",
    "cam",
    "camera",
    "camp",
    "cancerresearch",
    "canon",
    "capetown",
    "capital",
    "capitalone",
    "car",
    "caravan",
    "cards",
    "care",
    "career",
    "careers",
    "cars",
    "cartier",
    "casa",
    "case",
    "caseih",
    "cash",
    "casino",
    "catering",
    "catholic",
    "cba",
    "cbn",
    "cbre",
    "cbs",
    "ceb",
    "center",
    "ceo",
    "cern",
    "cfa",
    "cfd",
    "chanel",
    "channel",
    "charity",
    "chase",
    "chat",
    "cheap",
    "chintai",
    "christmas",
    "chrome",
    "chrysler",
    "church",
    "cipriani",
    "circle",
    "cisco",
    "citadel",
    "citi",
    "citic",
    "city",
    "cityeats",
    "claims",
    "cleaning",
    "click",
    "clinic",
    "clinique",
    "clothing",
    "cloud",
    "club",
    "clubmed",
    "coach",
    "codes",
    "coffee",
    "college",
    "cologne",
    "comcast",
    "commbank",
    "community",
    "company",
    "compare",
    "computer",
    "comsec",
    "condos",
    "construction",
    "consulting",
    "contact",
    "contractors",
    "cooking",
    "cookingchannel",
    "cool",
    "corsica",
    "country",
    "coupon",
    "coupons",
    "courses",
    "cpa",
    "credit",
    "creditcard",
    "creditunion",
    "cricket",
    "crown",
    "crs",
    "cruise",
    "cruises",
    "csc",
    "cuisinella",
    "cymru",
    "cyou",
    "dabur",
    "dad",
    "dance",
    "data",
    "date",
    "dating",
    "datsun",
    "day",
    "dclk",
    "dds",
    "deal",
    "dealer",
    "deals",
    "degree",
    "delivery",
    "dell",
    "deloitte",
    "delta",
    "democrat",
    "dental",
    "dentist",
    "desi",
    "design",
    "dev",
    "dhl",
    "diamonds",
    "diet",
    "digital",
    "direct",
    "directory",
    "discount",
    "discover",
    "dish",
    "diy",
    "dnp",
    "docs",
    "doctor",
    "dodge",
    "dog",
    "domains",
    "dot",
    "download",
    "drive",
    "dtv",
    "dubai",
    "duck",
    "dunlop",
    "dupont",
    "durban",
    "dvag",
    "dvr",
    "earth",
    "eat",
    "eco",
    "edeka",
    "education",
    "email",
    "emerck",
    "energy",
    "engineer",
    "engineering",
    "enterprises",
    "epson",
    "equipment",
    "ericsson",
    "erni",
    "esq",
    "estate",
    "esurance",
    "etisalat",
    "eurovision",
    "eus",
    "events",
    "everbank",
    "exchange",
    "expert",
    "exposed",
    "express",
    "extraspace",
    "fage",
    "fail",
    "fairwinds",
    "faith",
    "family",
    "fan",
    "fans",
    "farm",
    "farmers",
    "fashion",
    "fast",
    "fedex",
    "feedback",
    "ferrari",
    "ferrero",
    "fiat",
    "fidelity",
    "fido",
    "film",
    "final",
    "finance",
    "financial",
    "fire",
    "firestone",
    "firmdale",
    "fish",
    "fishing",
    "fit",
    "fitness",
    "flickr",
    "flights",
    "flir",
    "florist",
    "flowers",
    "fly",
    "foo",
    "food",
    "foodnetwork",
    "football",
    "ford",
    "forex",
    "forsale",
    "forum",
    "foundation",
    "fox",
    "free",
    "fresenius",
    "frl",
    "frogans",
    "frontdoor",
    "frontier",
    "ftr",
    "fujitsu",
    "fujixerox",
    "fun",
    "fund",
    "furniture",
    "futbol",
    "fyi",
    "gal",
    "gallery",
    "gallo",
    "gallup",
    "game",
    "games",
    "gap",
    "garden",
    "gay",
    "gbiz",
    "gdn",
    "gea",
    "gent",
    "genting",
    "george",
    "ggee",
    "gift",
    "gifts",
    "gives",
    "giving",
    "glade",
    "glass",
    "gle",
    "global",
    "globo",
    "gmail",
    "gmbh",
    "gmo",
    "gmx",
    "godaddy",
    "gold",
    "goldpoint",
    "golf",
    "goo",
    "goodyear",
    "goog",
    "google",
    "gop",
    "got",
    "grainger",
    "graphics",
    "gratis",
    "green",
    "gripe",
    "grocery",
    "group",
    "guardian",
    "gucci",
    "guge",
    "guide",
    "guitars",
    "guru",
    "hair",
    "hamburg",
    "hangout",
    "haus",
    "hbo",
    "hdfc",
    "hdfcbank",
    "health",
    "healthcare",
    "help",
    "helsinki",
    "here",
    "hermes",
    "hgtv",
    "hiphop",
    "hisamitsu",
    "hitachi",
    "hiv",
    "hkt",
    "hockey",
    "holdings",
    "holiday",
    "homedepot",
    "homegoods",
    "homes",
    "homesense",
    "honda",
    "horse",
    "hospital",
    "host",
    "hosting",
    "hot",
    "hoteles",
    "hotels",
    "hotmail",
    "house",
    "how",
    "hsbc",
    "hughes",
    "hyatt",
    "hyundai",
    "ibm",
    "icbc",
    "ice",
    "icu",
    "ieee",
    "ifm",
    "ikano",
    "imamat",
    "imdb",
    "immo",
    "immobilien",
    "inc",
    "industries",
    "infiniti",
    "ing",
    "ink",
    "institute",
    "insurance",
    "insure",
    "intel",
    "international",
    "intuit",
    "investments",
    "ipiranga",
    "irish",
    "ismaili",
    "ist",
    "istanbul",
    "itau",
    "itv",
    "iveco",
    "jaguar",
    "java",
    "jcb",
    "jcp",
    "jeep",
    "jetzt",
    "jewelry",
    "jio",
    "jll",
    "jmp",
    "jnj",
    "joburg",
    "jot",
    "joy",
    "jpmorgan",
    "jprs",
    "juegos",
    "juniper",
    "kaufen",
    "kddi",
    "kerryhotels",
    "kerrylogistics",
    "kerryproperties",
    "kfh",
    "kia",
    "kim",
    "kinder",
    "kindle",
    "kitchen",
    "kiwi",
    "koeln",
    "komatsu",
    "kosher",
    "kpmg",
    "kpn",
    "krd",
    "kred",
    "kuokgroup",
    "kyoto",
    "lacaixa",
    "ladbrokes",
    "lamborghini",
    "lamer",
    "lancaster",
    "lancia",
    "lancome",
    "land",
    "landrover",
    "lanxess",
    "lasalle",
    "lat",
    "latino",
    "latrobe",
    "law",
    "lawyer",
    "lds",
    "lease",
    "leclerc",
    "lefrak",
    "legal",
    "lego",
    "lexus",
    "lgbt",
    "liaison",
    "lidl",
    "life",
    "lifeinsurance",
    "lifestyle",
    "lighting",
    "like",
    "lilly",
    "limited",
    "limo",
    "lincoln",
    "linde",
    "link",
    "lipsy",
    "live",
    "living",
    "lixil",
    "llc",
    "llp",
    "loan",
    "loans",
    "locker",
    "locus",
    "loft",
    "lol",
    "london",
    "lotte",
    "lotto",
    "love",
    "lpl",
    "lplfinancial",
    "ltd",
    "ltda",
    "lundbeck",
    "lupin",
    "luxe",
    "luxury",
    "macys",
    "madrid",
    "maif",
    "maison",
    "makeup",
    "man",
    "management",
    "mango",
    "map",
    "market",
    "marketing",
    "markets",
    "marriott",
    "marshalls",
    "maserati",
    "mattel",
    "mba",
    "mckinsey",
    "med",
    "media",
    "meet",
    "melbourne",
    "meme",
    "memorial",
    "men",
    "menu",
    "merckmsd",
    "metlife",
    "miami",
    "microsoft",
    "mini",
    "mint",
    "mit",
    "mitsubishi",
    "mlb",
    "mls",
    "mma",
    "mobile",
    "moda",
    "moe",
    "moi",
    "mom",
    "monash",
    "money",
    "monster",
    "mopar",
    "mormon",
    "mortgage",
    "moscow",
    "moto",
    "motorcycles",
    "mov",
    "movie",
    "movistar",
    "msd",
    "mtn",
    "mtr",
    "mutual",
    "nab",
    "nadex",
    "nagoya",
    "nationwide",
    "natura",
    "navy",
    "nba",
    "nec",
    "netbank",
    "netflix",
    "network",
    "neustar",
    "new",
    "newholland",
    "news",
    "next",
    "nextdirect",
    "nexus",
    "nfl",
    "ngo",
    "nhk",
    "nico",
    "nike",
    "nikon",
    "ninja",
    "nissan",
    "nissay",
    "nokia",
    "northwesternmutual",
    "norton",
    "now",
    "nowruz",
    "nowtv",
    "nra",
    "nrw",
    "ntt",
    "nyc",
    "obi",
    "observer",
    "off",
    "office",
    "okinawa",
    "olayan",
    "olayangroup",
    "oldnavy",
    "ollo",
    "omega",
    "one",
    "ong",
    "onl",
    "online",
    "onyourside",
    "ooo",
    "open",
    "oracle",
    "orange",
    "organic",
    "origins",
    "osaka",
    "otsuka",
    "ott",
    "ovh",
    "page",
    "panasonic",
    "paris",
    "pars",
    "partners",
    "parts",
    "party",
    "passagens",
    "pay",
    "pccw",
    "pet",
    "pfizer",
    "pharmacy",
    "phd",
    "philips",
    "phone",
    "photo",
    "photography",
    "photos",
    "physio",
    "piaget",
    "pics",
    "pictet",
    "pictures",
    "pid",
    "pin",
    "ping",
    "pink",
    "pioneer",
    "pizza",
    "place",
    "play",
    "playstation",
    "plumbing",
    "plus",
    "pnc",
    "pohl",
    "poker",
    "politie",
    "porn",
    "pramerica",
    "praxi",
    "press",
    "prime",
    "prod",
    "productions",
    "prof",
    "progressive",
    "promo",
    "properties",
    "property",
    "protection",
    "pru",
    "prudential",
    "pub",
    "pwc",
    "qpon",
    "quebec",
    "quest",
    "qvc",
    "racing",
    "radio",
    "raid",
    "read",
    "realestate",
    "realtor",
    "realty",
    "recipes",
    "red",
    "redstone",
    "redumbrella",
    "rehab",
    "reise",
    "reisen",
    "reit",
    "reliance",
    "ren",
    "rent",
    "rentals",
    "repair",
    "report",
    "republican",
    "rest",
    "restaurant",
    "review",
    "reviews",
    "rexroth",
    "rich",
    "richardli",
    "ricoh",
    "rightathome",
    "ril",
    "rio",
    "rip",
    "rmit",
    "rocher",
    "rocks",
    "rodeo",
    "rogers",
    "room",
    "rsvp",
    "rugby",
    "ruhr",
    "run",
    "rwe",
    "ryukyu",
    "saarland",
    "safe",
    "safety",
    "sakura",
    "sale",
    "salon",
    "samsclub",
    "samsung",
    "sandvik",
    "sandvikcoromant",
    "sanofi",
    "sap",
    "sarl",
    "sas",
    "save",
    "saxo",
    "sbi",
    "sbs",
    "sca",
    "scb",
    "schaeffler",
    "schmidt",
    "scholarships",
    "school",
    "schule",
    "schwarz",
    "science",
    "scjohnson",
    "scor",
    "scot",
    "search",
    "seat",
    "secure",
    "security",
    "seek",
    "select",
    "sener",
    "services",
    "ses",
    "seven",
    "sew",
    "sex",
    "sexy",
    "sfr",
    "shangrila",
    "sharp",
    "shaw",
    "shell",
    "shia",
    "shiksha",
    "shoes",
    "shop",
    "shopping",
    "shouji",
    "show",
    "showtime",
    "shriram",
    "silk",
    "sina",
    "singles",
    "site",
    "ski",
    "skin",
    "sky",
    "skype",
    "sling",
    "smart",
    "smile",
    "sncf",
    "soccer",
    "social",
    "softbank",
    "software",
    "sohu",
    "solar",
    "solutions",
    "song",
    "sony",
    "soy",
    "spa",
    "space",
    "sport",
    "spot",
    "spreadbetting",
    "srl",
    "srt",
    "stada",
    "staples",
    "star",
    "statebank",
    "statefarm",
    "stc",
    "stcgroup",
    "stockholm",
    "storage",
    "store",
    "stream",
    "studio",
    "study",
    "style",
    "sucks",
    "supplies",
    "supply",
    "support",
    "surf",
    "surgery",
    "suzuki",
    "swatch",
    "swiftcover",
    "swiss",
    "sydney",
    "symantec",
    "systems",
    "tab",
    "taipei",
    "talk",
    "taobao",
    "target",
    "tatamotors",
    "tatar",
    "tattoo",
    "tax",
    "taxi",
    "tci",
    "tdk",
    "team",
    "tech",
    "technology",
    "telefonica",
    "temasek",
    "tennis",
    "teva",
    "thd",
    "theater",
    "theatre",
    "tiaa",
    "tickets",
    "tienda",
    "tiffany",
    "tips",
    "tires",
    "tirol",
    "tjmaxx",
    "tjx",
    "tkmaxx",
    "tmall",
    "today",
    "tokyo",
    "tools",
    "top",
    "toray",
    "toshiba",
    "total",
    "tours",
    "town",
    "toyota",
    "toys",
    "trade",
    "trading",
    "training",
    "travel",
    "travelchannel",
    "travelers",
    "travelersinsurance",
    "trust",
    "trv",
    "tube",
    "tui",
    "tunes",
    "tushu",
    "tvs",
    "ubank",
    "ubs",
    "uconnect",
    "unicom",
    "university",
    "uno",
    "uol",
    "ups",
    "vacations",
    "vana",
    "vanguard",
    "vegas",
    "ventures",
    "verisign",
    "versicherung",
    "vet",
    "viajes",
    "video",
    "vig",
    "viking",
    "villas",
    "vin",
    "vip",
    "virgin",
    "visa",
    "vision",
    "vistaprint",
    "viva",
    "vivo",
    "vlaanderen",
    "vodka",
    "volkswagen",
    "volvo",
    "vote",
    "voting",
    "voto",
    "voyage",
    "vuelos",
    "wales",
    "walmart",
    "walter",
    "wang",
    "wanggou",
    "warman",
    "watch",
    "watches",
    "weather",
    "weatherchannel",
    "webcam",
    "weber",
    "website",
    "wed",
    "wedding",
    "weibo",
    "weir",
    "whoswho",
    "wien",
    "wiki",
    "williamhill",
    "win",
    "windows",
    "wine",
    "winners",
    "wme",
    "wolterskluwer",
    "woodside",
    "work",
    "works",
    "world",
    "wow",
    "wtc",
    "wtf",
    "xbox",
    "xerox",
    "xfinity",
    "xihuan",
    "xin",
    "कॉम",
    "セール",
    "佛山",
    "慈善",
    "集团",
    "在线",
    "大众汽车",
    "点看",
    "คอม",
    "八卦",
    "موقع",
    "公益",
    "公司",
    "香格里拉",
    "网站",
    "移动",
    "我爱你",
    "москва",
    "католик",
    "онлайн",
    "сайт",
    "联通",
    "קום",
    "时尚",
    "微博",
    "淡马锡",
    "ファッション",
    "орг",
    "नेट",
    "ストア",
    "삼성",
    "商标",
    "商店",
    "商城",
    "дети",
    "ポイント",
    "新闻",
    "工行",
    "家電",
    "كوم",
    "中文网",
    "中信",
    "娱乐",
    "谷歌",
    "電訊盈科",
    "购物",
    "クラウド",
    "通販",
    "网店",
    "संगठन",
    "餐厅",
    "网络",
    "ком",
    "诺基亚",
    "食品",
    "飞利浦",
    "手表",
    "手机",
    "ارامكو",
    "العليان",
    "اتصالات",
    "بازار",
    "ابوظبي",
    "كاثوليك",
    "همراه",
    "닷컴",
    "政府",
    "شبكة",
    "بيتك",
    "عرب",
    "机构",
    "组织机构",
    "健康",
    "招聘",
    "рус",
    "珠宝",
    "大拿",
    "みんな",
    "グーグル",
    "世界",
    "書籍",
    "网址",
    "닷넷",
    "コム",
    "天主教",
    "游戏",
    "vermögensberater",
    "vermögensberatung",
    "企业",
    "信息",
    "嘉里大酒店",
    "嘉里",
    "广东",
    "政务",
    "xyz",
    "yachts",
    "yahoo",
    "yamaxun",
    "yandex",
    "yodobashi",
    "yoga",
    "yokohama",
    "you",
    "youtube",
    "yun",
    "zappos",
    "zara",
    "zero",
    "zip",
    "zone",
    "zuerich",
    "cc.ua",
    "inf.ua",
    "ltd.ua",
    "beep.pl",
    "barsy.ca",
    "*.compute.estate",
    "*.alces.network",
    "altervista.org",
    "alwaysdata.net",
    "cloudfront.net",
    "*.compute.amazonaws.com",
    "*.compute-1.amazonaws.com",
    "*.compute.amazonaws.com.cn",
    "us-east-1.amazonaws.com",
    "cn-north-1.eb.amazonaws.com.cn",
    "cn-northwest-1.eb.amazonaws.com.cn",
    "elasticbeanstalk.com",
    "ap-northeast-1.elasticbeanstalk.com",
    "ap-northeast-2.elasticbeanstalk.com",
    "ap-northeast-3.elasticbeanstalk.com",
    "ap-south-1.elasticbeanstalk.com",
    "ap-southeast-1.elasticbeanstalk.com",
    "ap-southeast-2.elasticbeanstalk.com",
    "ca-central-1.elasticbeanstalk.com",
    "eu-central-1.elasticbeanstalk.com",
    "eu-west-1.elasticbeanstalk.com",
    "eu-west-2.elasticbeanstalk.com",
    "eu-west-3.elasticbeanstalk.com",
    "sa-east-1.elasticbeanstalk.com",
    "us-east-1.elasticbeanstalk.com",
    "us-east-2.elasticbeanstalk.com",
    "us-gov-west-1.elasticbeanstalk.com",
    "us-west-1.elasticbeanstalk.com",
    "us-west-2.elasticbeanstalk.com",
    "*.elb.amazonaws.com",
    "*.elb.amazonaws.com.cn",
    "s3.amazonaws.com",
    "s3-ap-northeast-1.amazonaws.com",
    "s3-ap-northeast-2.amazonaws.com",
    "s3-ap-south-1.amazonaws.com",
    "s3-ap-southeast-1.amazonaws.com",
    "s3-ap-southeast-2.amazonaws.com",
    "s3-ca-central-1.amazonaws.com",
    "s3-eu-central-1.amazonaws.com",
    "s3-eu-west-1.amazonaws.com",
    "s3-eu-west-2.amazonaws.com",
    "s3-eu-west-3.amazonaws.com",
    "s3-external-1.amazonaws.com",
    "s3-fips-us-gov-west-1.amazonaws.com",
    "s3-sa-east-1.amazonaws.com",
    "s3-us-gov-west-1.amazonaws.com",
    "s3-us-east-2.amazonaws.com",
    "s3-us-west-1.amazonaws.com",
    "s3-us-west-2.amazonaws.com",
    "s3.ap-northeast-2.amazonaws.com",
    "s3.ap-south-1.amazonaws.com",
    "s3.cn-north-1.amazonaws.com.cn",
    "s3.ca-central-1.amazonaws.com",
    "s3.eu-central-1.amazonaws.com",
    "s3.eu-west-2.amazonaws.com",
    "s3.eu-west-3.amazonaws.com",
    "s3.us-east-2.amazonaws.com",
    "s3.dualstack.ap-northeast-1.amazonaws.com",
    "s3.dualstack.ap-northeast-2.amazonaws.com",
    "s3.dualstack.ap-south-1.amazonaws.com",
    "s3.dualstack.ap-southeast-1.amazonaws.com",
    "s3.dualstack.ap-southeast-2.amazonaws.com",
    "s3.dualstack.ca-central-1.amazonaws.com",
    "s3.dualstack.eu-central-1.amazonaws.com",
    "s3.dualstack.eu-west-1.amazonaws.com",
    "s3.dualstack.eu-west-2.amazonaws.com",
    "s3.dualstack.eu-west-3.amazonaws.com",
    "s3.dualstack.sa-east-1.amazonaws.com",
    "s3.dualstack.us-east-1.amazonaws.com",
    "s3.dualstack.us-east-2.amazonaws.com",
    "s3-website-us-east-1.amazonaws.com",
    "s3-website-us-west-1.amazonaws.com",
    "s3-website-us-west-2.amazonaws.com",
    "s3-website-ap-northeast-1.amazonaws.com",
    "s3-website-ap-southeast-1.amazonaws.com",
    "s3-website-ap-southeast-2.amazonaws.com",
    "s3-website-eu-west-1.amazonaws.com",
    "s3-website-sa-east-1.amazonaws.com",
    "s3-website.ap-northeast-2.amazonaws.com",
    "s3-website.ap-south-1.amazonaws.com",
    "s3-website.ca-central-1.amazonaws.com",
    "s3-website.eu-central-1.amazonaws.com",
    "s3-website.eu-west-2.amazonaws.com",
    "s3-website.eu-west-3.amazonaws.com",
    "s3-website.us-east-2.amazonaws.com",
    "t3l3p0rt.net",
    "tele.amune.org",
    "apigee.io",
    "on-aptible.com",
    "user.aseinet.ne.jp",
    "gv.vc",
    "d.gv.vc",
    "user.party.eus",
    "pimienta.org",
    "poivron.org",
    "potager.org",
    "sweetpepper.org",
    "myasustor.com",
    "go-vip.co",
    "go-vip.net",
    "wpcomstaging.com",
    "myfritz.net",
    "*.awdev.ca",
    "*.advisor.ws",
    "b-data.io",
    "backplaneapp.io",
    "balena-devices.com",
    "app.banzaicloud.io",
    "betainabox.com",
    "bnr.la",
    "blackbaudcdn.net",
    "boomla.net",
    "boxfuse.io",
    "square7.ch",
    "bplaced.com",
    "bplaced.de",
    "square7.de",
    "bplaced.net",
    "square7.net",
    "browsersafetymark.io",
    "uk0.bigv.io",
    "dh.bytemark.co.uk",
    "vm.bytemark.co.uk",
    "mycd.eu",
    "carrd.co",
    "crd.co",
    "uwu.ai",
    "ae.org",
    "ar.com",
    "br.com",
    "cn.com",
    "com.de",
    "com.se",
    "de.com",
    "eu.com",
    "gb.com",
    "gb.net",
    "hu.com",
    "hu.net",
    "jp.net",
    "jpn.com",
    "kr.com",
    "mex.com",
    "no.com",
    "qc.com",
    "ru.com",
    "sa.com",
    "se.net",
    "uk.com",
    "uk.net",
    "us.com",
    "uy.com",
    "za.bz",
    "za.com",
    "africa.com",
    "gr.com",
    "in.net",
    "us.org",
    "co.com",
    "c.la",
    "certmgr.org",
    "xenapponazure.com",
    "discourse.group",
    "virtueeldomein.nl",
    "cleverapps.io",
    "*.lcl.dev",
    "*.stg.dev",
    "c66.me",
    "cloud66.ws",
    "cloud66.zone",
    "jdevcloud.com",
    "wpdevcloud.com",
    "cloudaccess.host",
    "freesite.host",
    "cloudaccess.net",
    "cloudcontrolled.com",
    "cloudcontrolapp.com",
    "cloudera.site",
    "trycloudflare.com",
    "workers.dev",
    "wnext.app",
    "co.ca",
    "*.otap.co",
    "co.cz",
    "c.cdn77.org",
    "cdn77-ssl.net",
    "r.cdn77.net",
    "rsc.cdn77.org",
    "ssl.origin.cdn77-secure.org",
    "cloudns.asia",
    "cloudns.biz",
    "cloudns.club",
    "cloudns.cc",
    "cloudns.eu",
    "cloudns.in",
    "cloudns.info",
    "cloudns.org",
    "cloudns.pro",
    "cloudns.pw",
    "cloudns.us",
    "cloudeity.net",
    "cnpy.gdn",
    "co.nl",
    "co.no",
    "webhosting.be",
    "hosting-cluster.nl",
    "dyn.cosidns.de",
    "dynamisches-dns.de",
    "dnsupdater.de",
    "internet-dns.de",
    "l-o-g-i-n.de",
    "dynamic-dns.info",
    "feste-ip.net",
    "knx-server.net",
    "static-access.net",
    "realm.cz",
    "*.cryptonomic.net",
    "cupcake.is",
    "cyon.link",
    "cyon.site",
    "daplie.me",
    "localhost.daplie.me",
    "dattolocal.com",
    "dattorelay.com",
    "dattoweb.com",
    "mydatto.com",
    "dattolocal.net",
    "mydatto.net",
    "biz.dk",
    "co.dk",
    "firm.dk",
    "reg.dk",
    "store.dk",
    "*.dapps.earth",
    "*.bzz.dapps.earth",
    "debian.net",
    "dedyn.io",
    "dnshome.de",
    "online.th",
    "shop.th",
    "drayddns.com",
    "dreamhosters.com",
    "mydrobo.com",
    "drud.io",
    "drud.us",
    "duckdns.org",
    "dy.fi",
    "tunk.org",
    "dyndns-at-home.com",
    "dyndns-at-work.com",
    "dyndns-blog.com",
    "dyndns-free.com",
    "dyndns-home.com",
    "dyndns-ip.com",
    "dyndns-mail.com",
    "dyndns-office.com",
    "dyndns-pics.com",
    "dyndns-remote.com",
    "dyndns-server.com",
    "dyndns-web.com",
    "dyndns-wiki.com",
    "dyndns-work.com",
    "dyndns.biz",
    "dyndns.info",
    "dyndns.org",
    "dyndns.tv",
    "at-band-camp.net",
    "ath.cx",
    "barrel-of-knowledge.info",
    "barrell-of-knowledge.info",
    "better-than.tv",
    "blogdns.com",
    "blogdns.net",
    "blogdns.org",
    "blogsite.org",
    "boldlygoingnowhere.org",
    "broke-it.net",
    "buyshouses.net",
    "cechire.com",
    "dnsalias.com",
    "dnsalias.net",
    "dnsalias.org",
    "dnsdojo.com",
    "dnsdojo.net",
    "dnsdojo.org",
    "does-it.net",
    "doesntexist.com",
    "doesntexist.org",
    "dontexist.com",
    "dontexist.net",
    "dontexist.org",
    "doomdns.com",
    "doomdns.org",
    "dvrdns.org",
    "dyn-o-saur.com",
    "dynalias.com",
    "dynalias.net",
    "dynalias.org",
    "dynathome.net",
    "dyndns.ws",
    "endofinternet.net",
    "endofinternet.org",
    "endoftheinternet.org",
    "est-a-la-maison.com",
    "est-a-la-masion.com",
    "est-le-patron.com",
    "est-mon-blogueur.com",
    "for-better.biz",
    "for-more.biz",
    "for-our.info",
    "for-some.biz",
    "for-the.biz",
    "forgot.her.name",
    "forgot.his.name",
    "from-ak.com",
    "from-al.com",
    "from-ar.com",
    "from-az.net",
    "from-ca.com",
    "from-co.net",
    "from-ct.com",
    "from-dc.com",
    "from-de.com",
    "from-fl.com",
    "from-ga.com",
    "from-hi.com",
    "from-ia.com",
    "from-id.com",
    "from-il.com",
    "from-in.com",
    "from-ks.com",
    "from-ky.com",
    "from-la.net",
    "from-ma.com",
    "from-md.com",
    "from-me.org",
    "from-mi.com",
    "from-mn.com",
    "from-mo.com",
    "from-ms.com",
    "from-mt.com",
    "from-nc.com",
    "from-nd.com",
    "from-ne.com",
    "from-nh.com",
    "from-nj.com",
    "from-nm.com",
    "from-nv.com",
    "from-ny.net",
    "from-oh.com",
    "from-ok.com",
    "from-or.com",
    "from-pa.com",
    "from-pr.com",
    "from-ri.com",
    "from-sc.com",
    "from-sd.com",
    "from-tn.com",
    "from-tx.com",
    "from-ut.com",
    "from-va.com",
    "from-vt.com",
    "from-wa.com",
    "from-wi.com",
    "from-wv.com",
    "from-wy.com",
    "ftpaccess.cc",
    "fuettertdasnetz.de",
    "game-host.org",
    "game-server.cc",
    "getmyip.com",
    "gets-it.net",
    "go.dyndns.org",
    "gotdns.com",
    "gotdns.org",
    "groks-the.info",
    "groks-this.info",
    "ham-radio-op.net",
    "here-for-more.info",
    "hobby-site.com",
    "hobby-site.org",
    "home.dyndns.org",
    "homedns.org",
    "homeftp.net",
    "homeftp.org",
    "homeip.net",
    "homelinux.com",
    "homelinux.net",
    "homelinux.org",
    "homeunix.com",
    "homeunix.net",
    "homeunix.org",
    "iamallama.com",
    "in-the-band.net",
    "is-a-anarchist.com",
    "is-a-blogger.com",
    "is-a-bookkeeper.com",
    "is-a-bruinsfan.org",
    "is-a-bulls-fan.com",
    "is-a-candidate.org",
    "is-a-caterer.com",
    "is-a-celticsfan.org",
    "is-a-chef.com",
    "is-a-chef.net",
    "is-a-chef.org",
    "is-a-conservative.com",
    "is-a-cpa.com",
    "is-a-cubicle-slave.com",
    "is-a-democrat.com",
    "is-a-designer.com",
    "is-a-doctor.com",
    "is-a-financialadvisor.com",
    "is-a-geek.com",
    "is-a-geek.net",
    "is-a-geek.org",
    "is-a-green.com",
    "is-a-guru.com",
    "is-a-hard-worker.com",
    "is-a-hunter.com",
    "is-a-knight.org",
    "is-a-landscaper.com",
    "is-a-lawyer.com",
    "is-a-liberal.com",
    "is-a-libertarian.com",
    "is-a-linux-user.org",
    "is-a-llama.com",
    "is-a-musician.com",
    "is-a-nascarfan.com",
    "is-a-nurse.com",
    "is-a-painter.com",
    "is-a-patsfan.org",
    "is-a-personaltrainer.com",
    "is-a-photographer.com",
    "is-a-player.com",
    "is-a-republican.com",
    "is-a-rockstar.com",
    "is-a-socialist.com",
    "is-a-soxfan.org",
    "is-a-student.com",
    "is-a-teacher.com",
    "is-a-techie.com",
    "is-a-therapist.com",
    "is-an-accountant.com",
    "is-an-actor.com",
    "is-an-actress.com",
    "is-an-anarchist.com",
    "is-an-artist.com",
    "is-an-engineer.com",
    "is-an-entertainer.com",
    "is-by.us",
    "is-certified.com",
    "is-found.org",
    "is-gone.com",
    "is-into-anime.com",
    "is-into-cars.com",
    "is-into-cartoons.com",
    "is-into-games.com",
    "is-leet.com",
    "is-lost.org",
    "is-not-certified.com",
    "is-saved.org",
    "is-slick.com",
    "is-uberleet.com",
    "is-very-bad.org",
    "is-very-evil.org",
    "is-very-good.org",
    "is-very-nice.org",
    "is-very-sweet.org",
    "is-with-theband.com",
    "isa-geek.com",
    "isa-geek.net",
    "isa-geek.org",
    "isa-hockeynut.com",
    "issmarterthanyou.com",
    "isteingeek.de",
    "istmein.de",
    "kicks-ass.net",
    "kicks-ass.org",
    "knowsitall.info",
    "land-4-sale.us",
    "lebtimnetz.de",
    "leitungsen.de",
    "likes-pie.com",
    "likescandy.com",
    "merseine.nu",
    "mine.nu",
    "misconfused.org",
    "mypets.ws",
    "myphotos.cc",
    "neat-url.com",
    "office-on-the.net",
    "on-the-web.tv",
    "podzone.net",
    "podzone.org",
    "readmyblog.org",
    "saves-the-whales.com",
    "scrapper-site.net",
    "scrapping.cc",
    "selfip.biz",
    "selfip.com",
    "selfip.info",
    "selfip.net",
    "selfip.org",
    "sells-for-less.com",
    "sells-for-u.com",
    "sells-it.net",
    "sellsyourhome.org",
    "servebbs.com",
    "servebbs.net",
    "servebbs.org",
    "serveftp.net",
    "serveftp.org",
    "servegame.org",
    "shacknet.nu",
    "simple-url.com",
    "space-to-rent.com",
    "stuff-4-sale.org",
    "stuff-4-sale.us",
    "teaches-yoga.com",
    "thruhere.net",
    "traeumtgerade.de",
    "webhop.biz",
    "webhop.info",
    "webhop.net",
    "webhop.org",
    "worse-than.tv",
    "writesthisblog.com",
    "ddnss.de",
    "dyn.ddnss.de",
    "dyndns.ddnss.de",
    "dyndns1.de",
    "dyn-ip24.de",
    "home-webserver.de",
    "dyn.home-webserver.de",
    "myhome-server.de",
    "ddnss.org",
    "definima.net",
    "definima.io",
    "bci.dnstrace.pro",
    "ddnsfree.com",
    "ddnsgeek.com",
    "giize.com",
    "gleeze.com",
    "kozow.com",
    "loseyourip.com",
    "ooguy.com",
    "theworkpc.com",
    "casacam.net",
    "dynu.net",
    "accesscam.org",
    "camdvr.org",
    "freeddns.org",
    "mywire.org",
    "webredirect.org",
    "myddns.rocks",
    "blogsite.xyz",
    "dynv6.net",
    "e4.cz",
    "mytuleap.com",
    "onred.one",
    "staging.onred.one",
    "enonic.io",
    "customer.enonic.io",
    "eu.org",
    "al.eu.org",
    "asso.eu.org",
    "at.eu.org",
    "au.eu.org",
    "be.eu.org",
    "bg.eu.org",
    "ca.eu.org",
    "cd.eu.org",
    "ch.eu.org",
    "cn.eu.org",
    "cy.eu.org",
    "cz.eu.org",
    "de.eu.org",
    "dk.eu.org",
    "edu.eu.org",
    "ee.eu.org",
    "es.eu.org",
    "fi.eu.org",
    "fr.eu.org",
    "gr.eu.org",
    "hr.eu.org",
    "hu.eu.org",
    "ie.eu.org",
    "il.eu.org",
    "in.eu.org",
    "int.eu.org",
    "is.eu.org",
    "it.eu.org",
    "jp.eu.org",
    "kr.eu.org",
    "lt.eu.org",
    "lu.eu.org",
    "lv.eu.org",
    "mc.eu.org",
    "me.eu.org",
    "mk.eu.org",
    "mt.eu.org",
    "my.eu.org",
    "net.eu.org",
    "ng.eu.org",
    "nl.eu.org",
    "no.eu.org",
    "nz.eu.org",
    "paris.eu.org",
    "pl.eu.org",
    "pt.eu.org",
    "q-a.eu.org",
    "ro.eu.org",
    "ru.eu.org",
    "se.eu.org",
    "si.eu.org",
    "sk.eu.org",
    "tr.eu.org",
    "uk.eu.org",
    "us.eu.org",
    "eu-1.evennode.com",
    "eu-2.evennode.com",
    "eu-3.evennode.com",
    "eu-4.evennode.com",
    "us-1.evennode.com",
    "us-2.evennode.com",
    "us-3.evennode.com",
    "us-4.evennode.com",
    "twmail.cc",
    "twmail.net",
    "twmail.org",
    "mymailer.com.tw",
    "url.tw",
    "apps.fbsbx.com",
    "ru.net",
    "adygeya.ru",
    "bashkiria.ru",
    "bir.ru",
    "cbg.ru",
    "com.ru",
    "dagestan.ru",
    "grozny.ru",
    "kalmykia.ru",
    "kustanai.ru",
    "marine.ru",
    "mordovia.ru",
    "msk.ru",
    "mytis.ru",
    "nalchik.ru",
    "nov.ru",
    "pyatigorsk.ru",
    "spb.ru",
    "vladikavkaz.ru",
    "vladimir.ru",
    "abkhazia.su",
    "adygeya.su",
    "aktyubinsk.su",
    "arkhangelsk.su",
    "armenia.su",
    "ashgabad.su",
    "azerbaijan.su",
    "balashov.su",
    "bashkiria.su",
    "bryansk.su",
    "bukhara.su",
    "chimkent.su",
    "dagestan.su",
    "east-kazakhstan.su",
    "exnet.su",
    "georgia.su",
    "grozny.su",
    "ivanovo.su",
    "jambyl.su",
    "kalmykia.su",
    "kaluga.su",
    "karacol.su",
    "karaganda.su",
    "karelia.su",
    "khakassia.su",
    "krasnodar.su",
    "kurgan.su",
    "kustanai.su",
    "lenug.su",
    "mangyshlak.su",
    "mordovia.su",
    "msk.su",
    "murmansk.su",
    "nalchik.su",
    "navoi.su",
    "north-kazakhstan.su",
    "nov.su",
    "obninsk.su",
    "penza.su",
    "pokrovsk.su",
    "sochi.su",
    "spb.su",
    "tashkent.su",
    "termez.su",
    "togliatti.su",
    "troitsk.su",
    "tselinograd.su",
    "tula.su",
    "tuva.su",
    "vladikavkaz.su",
    "vladimir.su",
    "vologda.su",
    "channelsdvr.net",
    "fastly-terrarium.com",
    "fastlylb.net",
    "map.fastlylb.net",
    "freetls.fastly.net",
    "map.fastly.net",
    "a.prod.fastly.net",
    "global.prod.fastly.net",
    "a.ssl.fastly.net",
    "b.ssl.fastly.net",
    "global.ssl.fastly.net",
    "fastpanel.direct",
    "fastvps-server.com",
    "fhapp.xyz",
    "fedorainfracloud.org",
    "fedorapeople.org",
    "cloud.fedoraproject.org",
    "app.os.fedoraproject.org",
    "app.os.stg.fedoraproject.org",
    "mydobiss.com",
    "filegear.me",
    "filegear-au.me",
    "filegear-de.me",
    "filegear-gb.me",
    "filegear-ie.me",
    "filegear-jp.me",
    "filegear-sg.me",
    "firebaseapp.com",
    "flynnhub.com",
    "flynnhosting.net",
    "freebox-os.com",
    "freeboxos.com",
    "fbx-os.fr",
    "fbxos.fr",
    "freebox-os.fr",
    "freeboxos.fr",
    "freedesktop.org",
    "*.futurecms.at",
    "*.ex.futurecms.at",
    "*.in.futurecms.at",
    "futurehosting.at",
    "futuremailing.at",
    "*.ex.ortsinfo.at",
    "*.kunden.ortsinfo.at",
    "*.statics.cloud",
    "service.gov.uk",
    "gehirn.ne.jp",
    "usercontent.jp",
    "lab.ms",
    "github.io",
    "githubusercontent.com",
    "gitlab.io",
    "glitch.me",
    "lolipop.io",
    "cloudapps.digital",
    "london.cloudapps.digital",
    "homeoffice.gov.uk",
    "ro.im",
    "shop.ro",
    "goip.de",
    "run.app",
    "a.run.app",
    "web.app",
    "*.0emm.com",
    "appspot.com",
    "blogspot.ae",
    "blogspot.al",
    "blogspot.am",
    "blogspot.ba",
    "blogspot.be",
    "blogspot.bg",
    "blogspot.bj",
    "blogspot.ca",
    "blogspot.cf",
    "blogspot.ch",
    "blogspot.cl",
    "blogspot.co.at",
    "blogspot.co.id",
    "blogspot.co.il",
    "blogspot.co.ke",
    "blogspot.co.nz",
    "blogspot.co.uk",
    "blogspot.co.za",
    "blogspot.com",
    "blogspot.com.ar",
    "blogspot.com.au",
    "blogspot.com.br",
    "blogspot.com.by",
    "blogspot.com.co",
    "blogspot.com.cy",
    "blogspot.com.ee",
    "blogspot.com.eg",
    "blogspot.com.es",
    "blogspot.com.mt",
    "blogspot.com.ng",
    "blogspot.com.tr",
    "blogspot.com.uy",
    "blogspot.cv",
    "blogspot.cz",
    "blogspot.de",
    "blogspot.dk",
    "blogspot.fi",
    "blogspot.fr",
    "blogspot.gr",
    "blogspot.hk",
    "blogspot.hr",
    "blogspot.hu",
    "blogspot.ie",
    "blogspot.in",
    "blogspot.is",
    "blogspot.it",
    "blogspot.jp",
    "blogspot.kr",
    "blogspot.li",
    "blogspot.lt",
    "blogspot.lu",
    "blogspot.md",
    "blogspot.mk",
    "blogspot.mr",
    "blogspot.mx",
    "blogspot.my",
    "blogspot.nl",
    "blogspot.no",
    "blogspot.pe",
    "blogspot.pt",
    "blogspot.qa",
    "blogspot.re",
    "blogspot.ro",
    "blogspot.rs",
    "blogspot.ru",
    "blogspot.se",
    "blogspot.sg",
    "blogspot.si",
    "blogspot.sk",
    "blogspot.sn",
    "blogspot.td",
    "blogspot.tw",
    "blogspot.ug",
    "blogspot.vn",
    "cloudfunctions.net",
    "cloud.goog",
    "codespot.com",
    "googleapis.com",
    "googlecode.com",
    "pagespeedmobilizer.com",
    "publishproxy.com",
    "withgoogle.com",
    "withyoutube.com",
    "fin.ci",
    "free.hr",
    "caa.li",
    "ua.rs",
    "conf.se",
    "hs.zone",
    "hs.run",
    "hashbang.sh",
    "hasura.app",
    "hasura-app.io",
    "hepforge.org",
    "herokuapp.com",
    "herokussl.com",
    "myravendb.com",
    "ravendb.community",
    "ravendb.me",
    "development.run",
    "ravendb.run",
    "bpl.biz",
    "orx.biz",
    "ng.city",
    "biz.gl",
    "ng.ink",
    "col.ng",
    "firm.ng",
    "gen.ng",
    "ltd.ng",
    "ng.school",
    "sch.so",
    "häkkinen.fi",
    "*.moonscale.io",
    "moonscale.net",
    "iki.fi",
    "dyn-berlin.de",
    "in-berlin.de",
    "in-brb.de",
    "in-butter.de",
    "in-dsl.de",
    "in-dsl.net",
    "in-dsl.org",
    "in-vpn.de",
    "in-vpn.net",
    "in-vpn.org",
    "biz.at",
    "info.at",
    "info.cx",
    "ac.leg.br",
    "al.leg.br",
    "am.leg.br",
    "ap.leg.br",
    "ba.leg.br",
    "ce.leg.br",
    "df.leg.br",
    "es.leg.br",
    "go.leg.br",
    "ma.leg.br",
    "mg.leg.br",
    "ms.leg.br",
    "mt.leg.br",
    "pa.leg.br",
    "pb.leg.br",
    "pe.leg.br",
    "pi.leg.br",
    "pr.leg.br",
    "rj.leg.br",
    "rn.leg.br",
    "ro.leg.br",
    "rr.leg.br",
    "rs.leg.br",
    "sc.leg.br",
    "se.leg.br",
    "sp.leg.br",
    "to.leg.br",
    "pixolino.com",
    "ipifony.net",
    "mein-iserv.de",
    "test-iserv.de",
    "iserv.dev",
    "iobb.net",
    "myjino.ru",
    "*.hosting.myjino.ru",
    "*.landing.myjino.ru",
    "*.spectrum.myjino.ru",
    "*.vps.myjino.ru",
    "*.triton.zone",
    "*.cns.joyent.com",
    "js.org",
    "kaas.gg",
    "khplay.nl",
    "keymachine.de",
    "kinghost.net",
    "uni5.net",
    "knightpoint.systems",
    "co.krd",
    "edu.krd",
    "git-repos.de",
    "lcube-server.de",
    "svn-repos.de",
    "leadpages.co",
    "lpages.co",
    "lpusercontent.com",
    "lelux.site",
    "co.business",
    "co.education",
    "co.events",
    "co.financial",
    "co.network",
    "co.place",
    "co.technology",
    "app.lmpm.com",
    "linkitools.space",
    "linkyard.cloud",
    "linkyard-cloud.ch",
    "members.linode.com",
    "nodebalancer.linode.com",
    "we.bs",
    "loginline.app",
    "loginline.dev",
    "loginline.io",
    "loginline.services",
    "loginline.site",
    "krasnik.pl",
    "leczna.pl",
    "lubartow.pl",
    "lublin.pl",
    "poniatowa.pl",
    "swidnik.pl",
    "uklugs.org",
    "glug.org.uk",
    "lug.org.uk",
    "lugs.org.uk",
    "barsy.bg",
    "barsy.co.uk",
    "barsyonline.co.uk",
    "barsycenter.com",
    "barsyonline.com",
    "barsy.club",
    "barsy.de",
    "barsy.eu",
    "barsy.in",
    "barsy.info",
    "barsy.io",
    "barsy.me",
    "barsy.menu",
    "barsy.mobi",
    "barsy.net",
    "barsy.online",
    "barsy.org",
    "barsy.pro",
    "barsy.pub",
    "barsy.shop",
    "barsy.site",
    "barsy.support",
    "barsy.uk",
    "*.magentosite.cloud",
    "mayfirst.info",
    "mayfirst.org",
    "hb.cldmail.ru",
    "miniserver.com",
    "memset.net",
    "cloud.metacentrum.cz",
    "custom.metacentrum.cz",
    "flt.cloud.muni.cz",
    "usr.cloud.muni.cz",
    "meteorapp.com",
    "eu.meteorapp.com",
    "co.pl",
    "azurecontainer.io",
    "azurewebsites.net",
    "azure-mobile.net",
    "cloudapp.net",
    "mozilla-iot.org",
    "bmoattachments.org",
    "net.ru",
    "org.ru",
    "pp.ru",
    "ui.nabu.casa",
    "pony.club",
    "of.fashion",
    "on.fashion",
    "of.football",
    "in.london",
    "of.london",
    "for.men",
    "and.mom",
    "for.mom",
    "for.one",
    "for.sale",
    "of.work",
    "to.work",
    "nctu.me",
    "bitballoon.com",
    "netlify.com",
    "4u.com",
    "ngrok.io",
    "nh-serv.co.uk",
    "nfshost.com",
    "dnsking.ch",
    "mypi.co",
    "n4t.co",
    "001www.com",
    "ddnslive.com",
    "myiphost.com",
    "forumz.info",
    "16-b.it",
    "32-b.it",
    "64-b.it",
    "soundcast.me",
    "tcp4.me",
    "dnsup.net",
    "hicam.net",
    "now-dns.net",
    "ownip.net",
    "vpndns.net",
    "dynserv.org",
    "now-dns.org",
    "x443.pw",
    "now-dns.top",
    "ntdll.top",
    "freeddns.us",
    "crafting.xyz",
    "zapto.xyz",
    "nsupdate.info",
    "nerdpol.ovh",
    "blogsyte.com",
    "brasilia.me",
    "cable-modem.org",
    "ciscofreak.com",
    "collegefan.org",
    "couchpotatofries.org",
    "damnserver.com",
    "ddns.me",
    "ditchyourip.com",
    "dnsfor.me",
    "dnsiskinky.com",
    "dvrcam.info",
    "dynns.com",
    "eating-organic.net",
    "fantasyleague.cc",
    "geekgalaxy.com",
    "golffan.us",
    "health-carereform.com",
    "homesecuritymac.com",
    "homesecuritypc.com",
    "hopto.me",
    "ilovecollege.info",
    "loginto.me",
    "mlbfan.org",
    "mmafan.biz",
    "myactivedirectory.com",
    "mydissent.net",
    "myeffect.net",
    "mymediapc.net",
    "mypsx.net",
    "mysecuritycamera.com",
    "mysecuritycamera.net",
    "mysecuritycamera.org",
    "net-freaks.com",
    "nflfan.org",
    "nhlfan.net",
    "no-ip.ca",
    "no-ip.co.uk",
    "no-ip.net",
    "noip.us",
    "onthewifi.com",
    "pgafan.net",
    "point2this.com",
    "pointto.us",
    "privatizehealthinsurance.net",
    "quicksytes.com",
    "read-books.org",
    "securitytactics.com",
    "serveexchange.com",
    "servehumour.com",
    "servep2p.com",
    "servesarcasm.com",
    "stufftoread.com",
    "ufcfan.org",
    "unusualperson.com",
    "workisboring.com",
    "3utilities.com",
    "bounceme.net",
    "ddns.net",
    "ddnsking.com",
    "gotdns.ch",
    "hopto.org",
    "myftp.biz",
    "myftp.org",
    "myvnc.com",
    "no-ip.biz",
    "no-ip.info",
    "no-ip.org",
    "noip.me",
    "redirectme.net",
    "servebeer.com",
    "serveblog.net",
    "servecounterstrike.com",
    "serveftp.com",
    "servegame.com",
    "servehalflife.com",
    "servehttp.com",
    "serveirc.com",
    "serveminecraft.net",
    "servemp3.com",
    "servepics.com",
    "servequake.com",
    "sytes.net",
    "webhop.me",
    "zapto.org",
    "stage.nodeart.io",
    "nodum.co",
    "nodum.io",
    "pcloud.host",
    "nyc.mn",
    "nom.ae",
    "nom.af",
    "nom.ai",
    "nom.al",
    "nym.by",
    "nym.bz",
    "nom.cl",
    "nym.ec",
    "nom.gd",
    "nom.ge",
    "nom.gl",
    "nym.gr",
    "nom.gt",
    "nym.gy",
    "nym.hk",
    "nom.hn",
    "nym.ie",
    "nom.im",
    "nom.ke",
    "nym.kz",
    "nym.la",
    "nym.lc",
    "nom.li",
    "nym.li",
    "nym.lt",
    "nym.lu",
    "nym.me",
    "nom.mk",
    "nym.mn",
    "nym.mx",
    "nom.nu",
    "nym.nz",
    "nym.pe",
    "nym.pt",
    "nom.pw",
    "nom.qa",
    "nym.ro",
    "nom.rs",
    "nom.si",
    "nym.sk",
    "nom.st",
    "nym.su",
    "nym.sx",
    "nom.tj",
    "nym.tw",
    "nom.ug",
    "nom.uy",
    "nom.vc",
    "nom.vg",
    "cya.gg",
    "cloudycluster.net",
    "nid.io",
    "opencraft.hosting",
    "operaunite.com",
    "outsystemscloud.com",
    "ownprovider.com",
    "own.pm",
    "ox.rs",
    "oy.lc",
    "pgfog.com",
    "pagefrontapp.com",
    "art.pl",
    "gliwice.pl",
    "krakow.pl",
    "poznan.pl",
    "wroc.pl",
    "zakopane.pl",
    "pantheonsite.io",
    "gotpantheon.com",
    "mypep.link",
    "on-web.fr",
    "*.platform.sh",
    "*.platformsh.site",
    "dyn53.io",
    "co.bn",
    "xen.prgmr.com",
    "priv.at",
    "prvcy.page",
    "*.dweb.link",
    "protonet.io",
    "chirurgiens-dentistes-en-france.fr",
    "byen.site",
    "pubtls.org",
    "qualifioapp.com",
    "instantcloud.cn",
    "ras.ru",
    "qa2.com",
    "dev-myqnapcloud.com",
    "alpha-myqnapcloud.com",
    "myqnapcloud.com",
    "*.quipelements.com",
    "vapor.cloud",
    "vaporcloud.io",
    "rackmaze.com",
    "rackmaze.net",
    "*.on-rancher.cloud",
    "*.on-rio.io",
    "readthedocs.io",
    "rhcloud.com",
    "app.render.com",
    "onrender.com",
    "repl.co",
    "repl.run",
    "resindevice.io",
    "devices.resinstaging.io",
    "hzc.io",
    "wellbeingzone.eu",
    "ptplus.fit",
    "wellbeingzone.co.uk",
    "git-pages.rit.edu",
    "sandcats.io",
    "logoip.de",
    "logoip.com",
    "schokokeks.net",
    "scrysec.com",
    "firewall-gateway.com",
    "firewall-gateway.de",
    "my-gateway.de",
    "my-router.de",
    "spdns.de",
    "spdns.eu",
    "firewall-gateway.net",
    "my-firewall.org",
    "myfirewall.org",
    "spdns.org",
    "biz.ua",
    "co.ua",
    "pp.ua",
    "shiftedit.io",
    "myshopblocks.com",
    "shopitsite.com",
    "mo-siemens.io",
    "1kapp.com",
    "appchizi.com",
    "applinzi.com",
    "sinaapp.com",
    "vipsinaapp.com",
    "siteleaf.net",
    "bounty-full.com",
    "alpha.bounty-full.com",
    "beta.bounty-full.com",
    "stackhero-network.com",
    "static.land",
    "dev.static.land",
    "sites.static.land",
    "apps.lair.io",
    "*.stolos.io",
    "spacekit.io",
    "customer.speedpartner.de",
    "api.stdlib.com",
    "storj.farm",
    "utwente.io",
    "soc.srcf.net",
    "user.srcf.net",
    "temp-dns.com",
    "applicationcloud.io",
    "scapp.io",
    "*.s5y.io",
    "*.sensiosite.cloud",
    "syncloud.it",
    "diskstation.me",
    "dscloud.biz",
    "dscloud.me",
    "dscloud.mobi",
    "dsmynas.com",
    "dsmynas.net",
    "dsmynas.org",
    "familyds.com",
    "familyds.net",
    "familyds.org",
    "i234.me",
    "myds.me",
    "synology.me",
    "vpnplus.to",
    "direct.quickconnect.to",
    "taifun-dns.de",
    "gda.pl",
    "gdansk.pl",
    "gdynia.pl",
    "med.pl",
    "sopot.pl",
    "edugit.org",
    "telebit.app",
    "telebit.io",
    "*.telebit.xyz",
    "gwiddle.co.uk",
    "thingdustdata.com",
    "cust.dev.thingdust.io",
    "cust.disrec.thingdust.io",
    "cust.prod.thingdust.io",
    "cust.testing.thingdust.io",
    "arvo.network",
    "azimuth.network",
    "bloxcms.com",
    "townnews-staging.com",
    "12hp.at",
    "2ix.at",
    "4lima.at",
    "lima-city.at",
    "12hp.ch",
    "2ix.ch",
    "4lima.ch",
    "lima-city.ch",
    "trafficplex.cloud",
    "de.cool",
    "12hp.de",
    "2ix.de",
    "4lima.de",
    "lima-city.de",
    "1337.pictures",
    "clan.rip",
    "lima-city.rocks",
    "webspace.rocks",
    "lima.zone",
    "*.transurl.be",
    "*.transurl.eu",
    "*.transurl.nl",
    "tuxfamily.org",
    "dd-dns.de",
    "diskstation.eu",
    "diskstation.org",
    "dray-dns.de",
    "draydns.de",
    "dyn-vpn.de",
    "dynvpn.de",
    "mein-vigor.de",
    "my-vigor.de",
    "my-wan.de",
    "syno-ds.de",
    "synology-diskstation.de",
    "synology-ds.de",
    "uber.space",
    "*.uberspace.de",
    "hk.com",
    "hk.org",
    "ltd.hk",
    "inc.hk",
    "virtualuser.de",
    "virtual-user.de",
    "lib.de.us",
    "2038.io",
    "router.management",
    "v-info.info",
    "voorloper.cloud",
    "wafflecell.com",
    "*.webhare.dev",
    "wedeploy.io",
    "wedeploy.me",
    "wedeploy.sh",
    "remotewd.com",
    "wmflabs.org",
    "half.host",
    "xnbay.com",
    "u2.xnbay.com",
    "u2-local.xnbay.com",
    "cistron.nl",
    "demon.nl",
    "xs4all.space",
    "yandexcloud.net",
    "storage.yandexcloud.net",
    "website.yandexcloud.net",
    "official.academy",
    "yolasite.com",
    "ybo.faith",
    "yombo.me",
    "homelink.one",
    "ybo.party",
    "ybo.review",
    "ybo.science",
    "ybo.trade",
    "nohost.me",
    "noho.st",
    "za.net",
    "za.org",
    "now.sh",
    "bss.design",
    "basicserver.io",
    "virtualserver.io",
    "site.builder.nu",
    "enterprisecloud.nu"
];

module.exports = {
    tldList
};

},{}],5:[function(require,module,exports){
'use strict'

exports.byteLength = byteLength
exports.toByteArray = toByteArray
exports.fromByteArray = fromByteArray

var lookup = []
var revLookup = []
var Arr = typeof Uint8Array !== 'undefined' ? Uint8Array : Array

var code = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
for (var i = 0, len = code.length; i < len; ++i) {
  lookup[i] = code[i]
  revLookup[code.charCodeAt(i)] = i
}

// Support decoding URL-safe base64 strings, as Node.js does.
// See: https://en.wikipedia.org/wiki/Base64#URL_applications
revLookup['-'.charCodeAt(0)] = 62
revLookup['_'.charCodeAt(0)] = 63

function getLens (b64) {
  var len = b64.length

  if (len % 4 > 0) {
    throw new Error('Invalid string. Length must be a multiple of 4')
  }

  // Trim off extra bytes after placeholder bytes are found
  // See: https://github.com/beatgammit/base64-js/issues/42
  var validLen = b64.indexOf('=')
  if (validLen === -1) validLen = len

  var placeHoldersLen = validLen === len
    ? 0
    : 4 - (validLen % 4)

  return [validLen, placeHoldersLen]
}

// base64 is 4/3 + up to two characters of the original data
function byteLength (b64) {
  var lens = getLens(b64)
  var validLen = lens[0]
  var placeHoldersLen = lens[1]
  return ((validLen + placeHoldersLen) * 3 / 4) - placeHoldersLen
}

function _byteLength (b64, validLen, placeHoldersLen) {
  return ((validLen + placeHoldersLen) * 3 / 4) - placeHoldersLen
}

function toByteArray (b64) {
  var tmp
  var lens = getLens(b64)
  var validLen = lens[0]
  var placeHoldersLen = lens[1]

  var arr = new Arr(_byteLength(b64, validLen, placeHoldersLen))

  var curByte = 0

  // if there are placeholders, only get up to the last complete 4 chars
  var len = placeHoldersLen > 0
    ? validLen - 4
    : validLen

  for (var i = 0; i < len; i += 4) {
    tmp =
      (revLookup[b64.charCodeAt(i)] << 18) |
      (revLookup[b64.charCodeAt(i + 1)] << 12) |
      (revLookup[b64.charCodeAt(i + 2)] << 6) |
      revLookup[b64.charCodeAt(i + 3)]
    arr[curByte++] = (tmp >> 16) & 0xFF
    arr[curByte++] = (tmp >> 8) & 0xFF
    arr[curByte++] = tmp & 0xFF
  }

  if (placeHoldersLen === 2) {
    tmp =
      (revLookup[b64.charCodeAt(i)] << 2) |
      (revLookup[b64.charCodeAt(i + 1)] >> 4)
    arr[curByte++] = tmp & 0xFF
  }

  if (placeHoldersLen === 1) {
    tmp =
      (revLookup[b64.charCodeAt(i)] << 10) |
      (revLookup[b64.charCodeAt(i + 1)] << 4) |
      (revLookup[b64.charCodeAt(i + 2)] >> 2)
    arr[curByte++] = (tmp >> 8) & 0xFF
    arr[curByte++] = tmp & 0xFF
  }

  return arr
}

function tripletToBase64 (num) {
  return lookup[num >> 18 & 0x3F] +
    lookup[num >> 12 & 0x3F] +
    lookup[num >> 6 & 0x3F] +
    lookup[num & 0x3F]
}

function encodeChunk (uint8, start, end) {
  var tmp
  var output = []
  for (var i = start; i < end; i += 3) {
    tmp =
      ((uint8[i] << 16) & 0xFF0000) +
      ((uint8[i + 1] << 8) & 0xFF00) +
      (uint8[i + 2] & 0xFF)
    output.push(tripletToBase64(tmp))
  }
  return output.join('')
}

function fromByteArray (uint8) {
  var tmp
  var len = uint8.length
  var extraBytes = len % 3 // if we have 1 byte left, pad 2 bytes
  var parts = []
  var maxChunkLength = 16383 // must be multiple of 3

  // go through the array every three bytes, we'll deal with trailing stuff later
  for (var i = 0, len2 = len - extraBytes; i < len2; i += maxChunkLength) {
    parts.push(encodeChunk(
      uint8, i, (i + maxChunkLength) > len2 ? len2 : (i + maxChunkLength)
    ))
  }

  // pad the end with zeros, but make sure to not forget the extra bytes
  if (extraBytes === 1) {
    tmp = uint8[len - 1]
    parts.push(
      lookup[tmp >> 2] +
      lookup[(tmp << 4) & 0x3F] +
      '=='
    )
  } else if (extraBytes === 2) {
    tmp = (uint8[len - 2] << 8) + uint8[len - 1]
    parts.push(
      lookup[tmp >> 10] +
      lookup[(tmp >> 4) & 0x3F] +
      lookup[(tmp << 2) & 0x3F] +
      '='
    )
  }

  return parts.join('')
}

},{}],6:[function(require,module,exports){
/*!
 * The buffer module from node.js, for the browser.
 *
 * @author   Feross Aboukhadijeh <https://feross.org>
 * @license  MIT
 */
/* eslint-disable no-proto */

'use strict'

var base64 = require('base64-js')
var ieee754 = require('ieee754')

exports.Buffer = Buffer
exports.SlowBuffer = SlowBuffer
exports.INSPECT_MAX_BYTES = 50

var K_MAX_LENGTH = 0x7fffffff
exports.kMaxLength = K_MAX_LENGTH

/**
 * If `Buffer.TYPED_ARRAY_SUPPORT`:
 *   === true    Use Uint8Array implementation (fastest)
 *   === false   Print warning and recommend using `buffer` v4.x which has an Object
 *               implementation (most compatible, even IE6)
 *
 * Browsers that support typed arrays are IE 10+, Firefox 4+, Chrome 7+, Safari 5.1+,
 * Opera 11.6+, iOS 4.2+.
 *
 * We report that the browser does not support typed arrays if the are not subclassable
 * using __proto__. Firefox 4-29 lacks support for adding new properties to `Uint8Array`
 * (See: https://bugzilla.mozilla.org/show_bug.cgi?id=695438). IE 10 lacks support
 * for __proto__ and has a buggy typed array implementation.
 */
Buffer.TYPED_ARRAY_SUPPORT = typedArraySupport()

if (!Buffer.TYPED_ARRAY_SUPPORT && typeof console !== 'undefined' &&
    typeof console.error === 'function') {
  console.error(
    'This browser lacks typed array (Uint8Array) support which is required by ' +
    '`buffer` v5.x. Use `buffer` v4.x if you require old browser support.'
  )
}

function typedArraySupport () {
  // Can typed array instances can be augmented?
  try {
    var arr = new Uint8Array(1)
    arr.__proto__ = { __proto__: Uint8Array.prototype, foo: function () { return 42 } }
    return arr.foo() === 42
  } catch (e) {
    return false
  }
}

Object.defineProperty(Buffer.prototype, 'parent', {
  enumerable: true,
  get: function () {
    if (!Buffer.isBuffer(this)) return undefined
    return this.buffer
  }
})

Object.defineProperty(Buffer.prototype, 'offset', {
  enumerable: true,
  get: function () {
    if (!Buffer.isBuffer(this)) return undefined
    return this.byteOffset
  }
})

function createBuffer (length) {
  if (length > K_MAX_LENGTH) {
    throw new RangeError('The value "' + length + '" is invalid for option "size"')
  }
  // Return an augmented `Uint8Array` instance
  var buf = new Uint8Array(length)
  buf.__proto__ = Buffer.prototype
  return buf
}

/**
 * The Buffer constructor returns instances of `Uint8Array` that have their
 * prototype changed to `Buffer.prototype`. Furthermore, `Buffer` is a subclass of
 * `Uint8Array`, so the returned instances will have all the node `Buffer` methods
 * and the `Uint8Array` methods. Square bracket notation works as expected -- it
 * returns a single octet.
 *
 * The `Uint8Array` prototype remains unmodified.
 */

function Buffer (arg, encodingOrOffset, length) {
  // Common case.
  if (typeof arg === 'number') {
    if (typeof encodingOrOffset === 'string') {
      throw new TypeError(
        'The "string" argument must be of type string. Received type number'
      )
    }
    return allocUnsafe(arg)
  }
  return from(arg, encodingOrOffset, length)
}

// Fix subarray() in ES2016. See: https://github.com/feross/buffer/pull/97
if (typeof Symbol !== 'undefined' && Symbol.species != null &&
    Buffer[Symbol.species] === Buffer) {
  Object.defineProperty(Buffer, Symbol.species, {
    value: null,
    configurable: true,
    enumerable: false,
    writable: false
  })
}

Buffer.poolSize = 8192 // not used by this implementation

function from (value, encodingOrOffset, length) {
  if (typeof value === 'string') {
    return fromString(value, encodingOrOffset)
  }

  if (ArrayBuffer.isView(value)) {
    return fromArrayLike(value)
  }

  if (value == null) {
    throw TypeError(
      'The first argument must be one of type string, Buffer, ArrayBuffer, Array, ' +
      'or Array-like Object. Received type ' + (typeof value)
    )
  }

  if (isInstance(value, ArrayBuffer) ||
      (value && isInstance(value.buffer, ArrayBuffer))) {
    return fromArrayBuffer(value, encodingOrOffset, length)
  }

  if (typeof value === 'number') {
    throw new TypeError(
      'The "value" argument must not be of type number. Received type number'
    )
  }

  var valueOf = value.valueOf && value.valueOf()
  if (valueOf != null && valueOf !== value) {
    return Buffer.from(valueOf, encodingOrOffset, length)
  }

  var b = fromObject(value)
  if (b) return b

  if (typeof Symbol !== 'undefined' && Symbol.toPrimitive != null &&
      typeof value[Symbol.toPrimitive] === 'function') {
    return Buffer.from(
      value[Symbol.toPrimitive]('string'), encodingOrOffset, length
    )
  }

  throw new TypeError(
    'The first argument must be one of type string, Buffer, ArrayBuffer, Array, ' +
    'or Array-like Object. Received type ' + (typeof value)
  )
}

/**
 * Functionally equivalent to Buffer(arg, encoding) but throws a TypeError
 * if value is a number.
 * Buffer.from(str[, encoding])
 * Buffer.from(array)
 * Buffer.from(buffer)
 * Buffer.from(arrayBuffer[, byteOffset[, length]])
 **/
Buffer.from = function (value, encodingOrOffset, length) {
  return from(value, encodingOrOffset, length)
}

// Note: Change prototype *after* Buffer.from is defined to workaround Chrome bug:
// https://github.com/feross/buffer/pull/148
Buffer.prototype.__proto__ = Uint8Array.prototype
Buffer.__proto__ = Uint8Array

function assertSize (size) {
  if (typeof size !== 'number') {
    throw new TypeError('"size" argument must be of type number')
  } else if (size < 0) {
    throw new RangeError('The value "' + size + '" is invalid for option "size"')
  }
}

function alloc (size, fill, encoding) {
  assertSize(size)
  if (size <= 0) {
    return createBuffer(size)
  }
  if (fill !== undefined) {
    // Only pay attention to encoding if it's a string. This
    // prevents accidentally sending in a number that would
    // be interpretted as a start offset.
    return typeof encoding === 'string'
      ? createBuffer(size).fill(fill, encoding)
      : createBuffer(size).fill(fill)
  }
  return createBuffer(size)
}

/**
 * Creates a new filled Buffer instance.
 * alloc(size[, fill[, encoding]])
 **/
Buffer.alloc = function (size, fill, encoding) {
  return alloc(size, fill, encoding)
}

function allocUnsafe (size) {
  assertSize(size)
  return createBuffer(size < 0 ? 0 : checked(size) | 0)
}

/**
 * Equivalent to Buffer(num), by default creates a non-zero-filled Buffer instance.
 * */
Buffer.allocUnsafe = function (size) {
  return allocUnsafe(size)
}
/**
 * Equivalent to SlowBuffer(num), by default creates a non-zero-filled Buffer instance.
 */
Buffer.allocUnsafeSlow = function (size) {
  return allocUnsafe(size)
}

function fromString (string, encoding) {
  if (typeof encoding !== 'string' || encoding === '') {
    encoding = 'utf8'
  }

  if (!Buffer.isEncoding(encoding)) {
    throw new TypeError('Unknown encoding: ' + encoding)
  }

  var length = byteLength(string, encoding) | 0
  var buf = createBuffer(length)

  var actual = buf.write(string, encoding)

  if (actual !== length) {
    // Writing a hex string, for example, that contains invalid characters will
    // cause everything after the first invalid character to be ignored. (e.g.
    // 'abxxcd' will be treated as 'ab')
    buf = buf.slice(0, actual)
  }

  return buf
}

function fromArrayLike (array) {
  var length = array.length < 0 ? 0 : checked(array.length) | 0
  var buf = createBuffer(length)
  for (var i = 0; i < length; i += 1) {
    buf[i] = array[i] & 255
  }
  return buf
}

function fromArrayBuffer (array, byteOffset, length) {
  if (byteOffset < 0 || array.byteLength < byteOffset) {
    throw new RangeError('"offset" is outside of buffer bounds')
  }

  if (array.byteLength < byteOffset + (length || 0)) {
    throw new RangeError('"length" is outside of buffer bounds')
  }

  var buf
  if (byteOffset === undefined && length === undefined) {
    buf = new Uint8Array(array)
  } else if (length === undefined) {
    buf = new Uint8Array(array, byteOffset)
  } else {
    buf = new Uint8Array(array, byteOffset, length)
  }

  // Return an augmented `Uint8Array` instance
  buf.__proto__ = Buffer.prototype
  return buf
}

function fromObject (obj) {
  if (Buffer.isBuffer(obj)) {
    var len = checked(obj.length) | 0
    var buf = createBuffer(len)

    if (buf.length === 0) {
      return buf
    }

    obj.copy(buf, 0, 0, len)
    return buf
  }

  if (obj.length !== undefined) {
    if (typeof obj.length !== 'number' || numberIsNaN(obj.length)) {
      return createBuffer(0)
    }
    return fromArrayLike(obj)
  }

  if (obj.type === 'Buffer' && Array.isArray(obj.data)) {
    return fromArrayLike(obj.data)
  }
}

function checked (length) {
  // Note: cannot use `length < K_MAX_LENGTH` here because that fails when
  // length is NaN (which is otherwise coerced to zero.)
  if (length >= K_MAX_LENGTH) {
    throw new RangeError('Attempt to allocate Buffer larger than maximum ' +
                         'size: 0x' + K_MAX_LENGTH.toString(16) + ' bytes')
  }
  return length | 0
}

function SlowBuffer (length) {
  if (+length != length) { // eslint-disable-line eqeqeq
    length = 0
  }
  return Buffer.alloc(+length)
}

Buffer.isBuffer = function isBuffer (b) {
  return b != null && b._isBuffer === true &&
    b !== Buffer.prototype // so Buffer.isBuffer(Buffer.prototype) will be false
}

Buffer.compare = function compare (a, b) {
  if (isInstance(a, Uint8Array)) a = Buffer.from(a, a.offset, a.byteLength)
  if (isInstance(b, Uint8Array)) b = Buffer.from(b, b.offset, b.byteLength)
  if (!Buffer.isBuffer(a) || !Buffer.isBuffer(b)) {
    throw new TypeError(
      'The "buf1", "buf2" arguments must be one of type Buffer or Uint8Array'
    )
  }

  if (a === b) return 0

  var x = a.length
  var y = b.length

  for (var i = 0, len = Math.min(x, y); i < len; ++i) {
    if (a[i] !== b[i]) {
      x = a[i]
      y = b[i]
      break
    }
  }

  if (x < y) return -1
  if (y < x) return 1
  return 0
}

Buffer.isEncoding = function isEncoding (encoding) {
  switch (String(encoding).toLowerCase()) {
    case 'hex':
    case 'utf8':
    case 'utf-8':
    case 'ascii':
    case 'latin1':
    case 'binary':
    case 'base64':
    case 'ucs2':
    case 'ucs-2':
    case 'utf16le':
    case 'utf-16le':
      return true
    default:
      return false
  }
}

Buffer.concat = function concat (list, length) {
  if (!Array.isArray(list)) {
    throw new TypeError('"list" argument must be an Array of Buffers')
  }

  if (list.length === 0) {
    return Buffer.alloc(0)
  }

  var i
  if (length === undefined) {
    length = 0
    for (i = 0; i < list.length; ++i) {
      length += list[i].length
    }
  }

  var buffer = Buffer.allocUnsafe(length)
  var pos = 0
  for (i = 0; i < list.length; ++i) {
    var buf = list[i]
    if (isInstance(buf, Uint8Array)) {
      buf = Buffer.from(buf)
    }
    if (!Buffer.isBuffer(buf)) {
      throw new TypeError('"list" argument must be an Array of Buffers')
    }
    buf.copy(buffer, pos)
    pos += buf.length
  }
  return buffer
}

function byteLength (string, encoding) {
  if (Buffer.isBuffer(string)) {
    return string.length
  }
  if (ArrayBuffer.isView(string) || isInstance(string, ArrayBuffer)) {
    return string.byteLength
  }
  if (typeof string !== 'string') {
    throw new TypeError(
      'The "string" argument must be one of type string, Buffer, or ArrayBuffer. ' +
      'Received type ' + typeof string
    )
  }

  var len = string.length
  var mustMatch = (arguments.length > 2 && arguments[2] === true)
  if (!mustMatch && len === 0) return 0

  // Use a for loop to avoid recursion
  var loweredCase = false
  for (;;) {
    switch (encoding) {
      case 'ascii':
      case 'latin1':
      case 'binary':
        return len
      case 'utf8':
      case 'utf-8':
        return utf8ToBytes(string).length
      case 'ucs2':
      case 'ucs-2':
      case 'utf16le':
      case 'utf-16le':
        return len * 2
      case 'hex':
        return len >>> 1
      case 'base64':
        return base64ToBytes(string).length
      default:
        if (loweredCase) {
          return mustMatch ? -1 : utf8ToBytes(string).length // assume utf8
        }
        encoding = ('' + encoding).toLowerCase()
        loweredCase = true
    }
  }
}
Buffer.byteLength = byteLength

function slowToString (encoding, start, end) {
  var loweredCase = false

  // No need to verify that "this.length <= MAX_UINT32" since it's a read-only
  // property of a typed array.

  // This behaves neither like String nor Uint8Array in that we set start/end
  // to their upper/lower bounds if the value passed is out of range.
  // undefined is handled specially as per ECMA-262 6th Edition,
  // Section 13.3.3.7 Runtime Semantics: KeyedBindingInitialization.
  if (start === undefined || start < 0) {
    start = 0
  }
  // Return early if start > this.length. Done here to prevent potential uint32
  // coercion fail below.
  if (start > this.length) {
    return ''
  }

  if (end === undefined || end > this.length) {
    end = this.length
  }

  if (end <= 0) {
    return ''
  }

  // Force coersion to uint32. This will also coerce falsey/NaN values to 0.
  end >>>= 0
  start >>>= 0

  if (end <= start) {
    return ''
  }

  if (!encoding) encoding = 'utf8'

  while (true) {
    switch (encoding) {
      case 'hex':
        return hexSlice(this, start, end)

      case 'utf8':
      case 'utf-8':
        return utf8Slice(this, start, end)

      case 'ascii':
        return asciiSlice(this, start, end)

      case 'latin1':
      case 'binary':
        return latin1Slice(this, start, end)

      case 'base64':
        return base64Slice(this, start, end)

      case 'ucs2':
      case 'ucs-2':
      case 'utf16le':
      case 'utf-16le':
        return utf16leSlice(this, start, end)

      default:
        if (loweredCase) throw new TypeError('Unknown encoding: ' + encoding)
        encoding = (encoding + '').toLowerCase()
        loweredCase = true
    }
  }
}

// This property is used by `Buffer.isBuffer` (and the `is-buffer` npm package)
// to detect a Buffer instance. It's not possible to use `instanceof Buffer`
// reliably in a browserify context because there could be multiple different
// copies of the 'buffer' package in use. This method works even for Buffer
// instances that were created from another copy of the `buffer` package.
// See: https://github.com/feross/buffer/issues/154
Buffer.prototype._isBuffer = true

function swap (b, n, m) {
  var i = b[n]
  b[n] = b[m]
  b[m] = i
}

Buffer.prototype.swap16 = function swap16 () {
  var len = this.length
  if (len % 2 !== 0) {
    throw new RangeError('Buffer size must be a multiple of 16-bits')
  }
  for (var i = 0; i < len; i += 2) {
    swap(this, i, i + 1)
  }
  return this
}

Buffer.prototype.swap32 = function swap32 () {
  var len = this.length
  if (len % 4 !== 0) {
    throw new RangeError('Buffer size must be a multiple of 32-bits')
  }
  for (var i = 0; i < len; i += 4) {
    swap(this, i, i + 3)
    swap(this, i + 1, i + 2)
  }
  return this
}

Buffer.prototype.swap64 = function swap64 () {
  var len = this.length
  if (len % 8 !== 0) {
    throw new RangeError('Buffer size must be a multiple of 64-bits')
  }
  for (var i = 0; i < len; i += 8) {
    swap(this, i, i + 7)
    swap(this, i + 1, i + 6)
    swap(this, i + 2, i + 5)
    swap(this, i + 3, i + 4)
  }
  return this
}

Buffer.prototype.toString = function toString () {
  var length = this.length
  if (length === 0) return ''
  if (arguments.length === 0) return utf8Slice(this, 0, length)
  return slowToString.apply(this, arguments)
}

Buffer.prototype.toLocaleString = Buffer.prototype.toString

Buffer.prototype.equals = function equals (b) {
  if (!Buffer.isBuffer(b)) throw new TypeError('Argument must be a Buffer')
  if (this === b) return true
  return Buffer.compare(this, b) === 0
}

Buffer.prototype.inspect = function inspect () {
  var str = ''
  var max = exports.INSPECT_MAX_BYTES
  str = this.toString('hex', 0, max).replace(/(.{2})/g, '$1 ').trim()
  if (this.length > max) str += ' ... '
  return '<Buffer ' + str + '>'
}

Buffer.prototype.compare = function compare (target, start, end, thisStart, thisEnd) {
  if (isInstance(target, Uint8Array)) {
    target = Buffer.from(target, target.offset, target.byteLength)
  }
  if (!Buffer.isBuffer(target)) {
    throw new TypeError(
      'The "target" argument must be one of type Buffer or Uint8Array. ' +
      'Received type ' + (typeof target)
    )
  }

  if (start === undefined) {
    start = 0
  }
  if (end === undefined) {
    end = target ? target.length : 0
  }
  if (thisStart === undefined) {
    thisStart = 0
  }
  if (thisEnd === undefined) {
    thisEnd = this.length
  }

  if (start < 0 || end > target.length || thisStart < 0 || thisEnd > this.length) {
    throw new RangeError('out of range index')
  }

  if (thisStart >= thisEnd && start >= end) {
    return 0
  }
  if (thisStart >= thisEnd) {
    return -1
  }
  if (start >= end) {
    return 1
  }

  start >>>= 0
  end >>>= 0
  thisStart >>>= 0
  thisEnd >>>= 0

  if (this === target) return 0

  var x = thisEnd - thisStart
  var y = end - start
  var len = Math.min(x, y)

  var thisCopy = this.slice(thisStart, thisEnd)
  var targetCopy = target.slice(start, end)

  for (var i = 0; i < len; ++i) {
    if (thisCopy[i] !== targetCopy[i]) {
      x = thisCopy[i]
      y = targetCopy[i]
      break
    }
  }

  if (x < y) return -1
  if (y < x) return 1
  return 0
}

// Finds either the first index of `val` in `buffer` at offset >= `byteOffset`,
// OR the last index of `val` in `buffer` at offset <= `byteOffset`.
//
// Arguments:
// - buffer - a Buffer to search
// - val - a string, Buffer, or number
// - byteOffset - an index into `buffer`; will be clamped to an int32
// - encoding - an optional encoding, relevant is val is a string
// - dir - true for indexOf, false for lastIndexOf
function bidirectionalIndexOf (buffer, val, byteOffset, encoding, dir) {
  // Empty buffer means no match
  if (buffer.length === 0) return -1

  // Normalize byteOffset
  if (typeof byteOffset === 'string') {
    encoding = byteOffset
    byteOffset = 0
  } else if (byteOffset > 0x7fffffff) {
    byteOffset = 0x7fffffff
  } else if (byteOffset < -0x80000000) {
    byteOffset = -0x80000000
  }
  byteOffset = +byteOffset // Coerce to Number.
  if (numberIsNaN(byteOffset)) {
    // byteOffset: it it's undefined, null, NaN, "foo", etc, search whole buffer
    byteOffset = dir ? 0 : (buffer.length - 1)
  }

  // Normalize byteOffset: negative offsets start from the end of the buffer
  if (byteOffset < 0) byteOffset = buffer.length + byteOffset
  if (byteOffset >= buffer.length) {
    if (dir) return -1
    else byteOffset = buffer.length - 1
  } else if (byteOffset < 0) {
    if (dir) byteOffset = 0
    else return -1
  }

  // Normalize val
  if (typeof val === 'string') {
    val = Buffer.from(val, encoding)
  }

  // Finally, search either indexOf (if dir is true) or lastIndexOf
  if (Buffer.isBuffer(val)) {
    // Special case: looking for empty string/buffer always fails
    if (val.length === 0) {
      return -1
    }
    return arrayIndexOf(buffer, val, byteOffset, encoding, dir)
  } else if (typeof val === 'number') {
    val = val & 0xFF // Search for a byte value [0-255]
    if (typeof Uint8Array.prototype.indexOf === 'function') {
      if (dir) {
        return Uint8Array.prototype.indexOf.call(buffer, val, byteOffset)
      } else {
        return Uint8Array.prototype.lastIndexOf.call(buffer, val, byteOffset)
      }
    }
    return arrayIndexOf(buffer, [ val ], byteOffset, encoding, dir)
  }

  throw new TypeError('val must be string, number or Buffer')
}

function arrayIndexOf (arr, val, byteOffset, encoding, dir) {
  var indexSize = 1
  var arrLength = arr.length
  var valLength = val.length

  if (encoding !== undefined) {
    encoding = String(encoding).toLowerCase()
    if (encoding === 'ucs2' || encoding === 'ucs-2' ||
        encoding === 'utf16le' || encoding === 'utf-16le') {
      if (arr.length < 2 || val.length < 2) {
        return -1
      }
      indexSize = 2
      arrLength /= 2
      valLength /= 2
      byteOffset /= 2
    }
  }

  function read (buf, i) {
    if (indexSize === 1) {
      return buf[i]
    } else {
      return buf.readUInt16BE(i * indexSize)
    }
  }

  var i
  if (dir) {
    var foundIndex = -1
    for (i = byteOffset; i < arrLength; i++) {
      if (read(arr, i) === read(val, foundIndex === -1 ? 0 : i - foundIndex)) {
        if (foundIndex === -1) foundIndex = i
        if (i - foundIndex + 1 === valLength) return foundIndex * indexSize
      } else {
        if (foundIndex !== -1) i -= i - foundIndex
        foundIndex = -1
      }
    }
  } else {
    if (byteOffset + valLength > arrLength) byteOffset = arrLength - valLength
    for (i = byteOffset; i >= 0; i--) {
      var found = true
      for (var j = 0; j < valLength; j++) {
        if (read(arr, i + j) !== read(val, j)) {
          found = false
          break
        }
      }
      if (found) return i
    }
  }

  return -1
}

Buffer.prototype.includes = function includes (val, byteOffset, encoding) {
  return this.indexOf(val, byteOffset, encoding) !== -1
}

Buffer.prototype.indexOf = function indexOf (val, byteOffset, encoding) {
  return bidirectionalIndexOf(this, val, byteOffset, encoding, true)
}

Buffer.prototype.lastIndexOf = function lastIndexOf (val, byteOffset, encoding) {
  return bidirectionalIndexOf(this, val, byteOffset, encoding, false)
}

function hexWrite (buf, string, offset, length) {
  offset = Number(offset) || 0
  var remaining = buf.length - offset
  if (!length) {
    length = remaining
  } else {
    length = Number(length)
    if (length > remaining) {
      length = remaining
    }
  }

  var strLen = string.length

  if (length > strLen / 2) {
    length = strLen / 2
  }
  for (var i = 0; i < length; ++i) {
    var parsed = parseInt(string.substr(i * 2, 2), 16)
    if (numberIsNaN(parsed)) return i
    buf[offset + i] = parsed
  }
  return i
}

function utf8Write (buf, string, offset, length) {
  return blitBuffer(utf8ToBytes(string, buf.length - offset), buf, offset, length)
}

function asciiWrite (buf, string, offset, length) {
  return blitBuffer(asciiToBytes(string), buf, offset, length)
}

function latin1Write (buf, string, offset, length) {
  return asciiWrite(buf, string, offset, length)
}

function base64Write (buf, string, offset, length) {
  return blitBuffer(base64ToBytes(string), buf, offset, length)
}

function ucs2Write (buf, string, offset, length) {
  return blitBuffer(utf16leToBytes(string, buf.length - offset), buf, offset, length)
}

Buffer.prototype.write = function write (string, offset, length, encoding) {
  // Buffer#write(string)
  if (offset === undefined) {
    encoding = 'utf8'
    length = this.length
    offset = 0
  // Buffer#write(string, encoding)
  } else if (length === undefined && typeof offset === 'string') {
    encoding = offset
    length = this.length
    offset = 0
  // Buffer#write(string, offset[, length][, encoding])
  } else if (isFinite(offset)) {
    offset = offset >>> 0
    if (isFinite(length)) {
      length = length >>> 0
      if (encoding === undefined) encoding = 'utf8'
    } else {
      encoding = length
      length = undefined
    }
  } else {
    throw new Error(
      'Buffer.write(string, encoding, offset[, length]) is no longer supported'
    )
  }

  var remaining = this.length - offset
  if (length === undefined || length > remaining) length = remaining

  if ((string.length > 0 && (length < 0 || offset < 0)) || offset > this.length) {
    throw new RangeError('Attempt to write outside buffer bounds')
  }

  if (!encoding) encoding = 'utf8'

  var loweredCase = false
  for (;;) {
    switch (encoding) {
      case 'hex':
        return hexWrite(this, string, offset, length)

      case 'utf8':
      case 'utf-8':
        return utf8Write(this, string, offset, length)

      case 'ascii':
        return asciiWrite(this, string, offset, length)

      case 'latin1':
      case 'binary':
        return latin1Write(this, string, offset, length)

      case 'base64':
        // Warning: maxLength not taken into account in base64Write
        return base64Write(this, string, offset, length)

      case 'ucs2':
      case 'ucs-2':
      case 'utf16le':
      case 'utf-16le':
        return ucs2Write(this, string, offset, length)

      default:
        if (loweredCase) throw new TypeError('Unknown encoding: ' + encoding)
        encoding = ('' + encoding).toLowerCase()
        loweredCase = true
    }
  }
}

Buffer.prototype.toJSON = function toJSON () {
  return {
    type: 'Buffer',
    data: Array.prototype.slice.call(this._arr || this, 0)
  }
}

function base64Slice (buf, start, end) {
  if (start === 0 && end === buf.length) {
    return base64.fromByteArray(buf)
  } else {
    return base64.fromByteArray(buf.slice(start, end))
  }
}

function utf8Slice (buf, start, end) {
  end = Math.min(buf.length, end)
  var res = []

  var i = start
  while (i < end) {
    var firstByte = buf[i]
    var codePoint = null
    var bytesPerSequence = (firstByte > 0xEF) ? 4
      : (firstByte > 0xDF) ? 3
        : (firstByte > 0xBF) ? 2
          : 1

    if (i + bytesPerSequence <= end) {
      var secondByte, thirdByte, fourthByte, tempCodePoint

      switch (bytesPerSequence) {
        case 1:
          if (firstByte < 0x80) {
            codePoint = firstByte
          }
          break
        case 2:
          secondByte = buf[i + 1]
          if ((secondByte & 0xC0) === 0x80) {
            tempCodePoint = (firstByte & 0x1F) << 0x6 | (secondByte & 0x3F)
            if (tempCodePoint > 0x7F) {
              codePoint = tempCodePoint
            }
          }
          break
        case 3:
          secondByte = buf[i + 1]
          thirdByte = buf[i + 2]
          if ((secondByte & 0xC0) === 0x80 && (thirdByte & 0xC0) === 0x80) {
            tempCodePoint = (firstByte & 0xF) << 0xC | (secondByte & 0x3F) << 0x6 | (thirdByte & 0x3F)
            if (tempCodePoint > 0x7FF && (tempCodePoint < 0xD800 || tempCodePoint > 0xDFFF)) {
              codePoint = tempCodePoint
            }
          }
          break
        case 4:
          secondByte = buf[i + 1]
          thirdByte = buf[i + 2]
          fourthByte = buf[i + 3]
          if ((secondByte & 0xC0) === 0x80 && (thirdByte & 0xC0) === 0x80 && (fourthByte & 0xC0) === 0x80) {
            tempCodePoint = (firstByte & 0xF) << 0x12 | (secondByte & 0x3F) << 0xC | (thirdByte & 0x3F) << 0x6 | (fourthByte & 0x3F)
            if (tempCodePoint > 0xFFFF && tempCodePoint < 0x110000) {
              codePoint = tempCodePoint
            }
          }
      }
    }

    if (codePoint === null) {
      // we did not generate a valid codePoint so insert a
      // replacement char (U+FFFD) and advance only 1 byte
      codePoint = 0xFFFD
      bytesPerSequence = 1
    } else if (codePoint > 0xFFFF) {
      // encode to utf16 (surrogate pair dance)
      codePoint -= 0x10000
      res.push(codePoint >>> 10 & 0x3FF | 0xD800)
      codePoint = 0xDC00 | codePoint & 0x3FF
    }

    res.push(codePoint)
    i += bytesPerSequence
  }

  return decodeCodePointsArray(res)
}

// Based on http://stackoverflow.com/a/22747272/680742, the browser with
// the lowest limit is Chrome, with 0x10000 args.
// We go 1 magnitude less, for safety
var MAX_ARGUMENTS_LENGTH = 0x1000

function decodeCodePointsArray (codePoints) {
  var len = codePoints.length
  if (len <= MAX_ARGUMENTS_LENGTH) {
    return String.fromCharCode.apply(String, codePoints) // avoid extra slice()
  }

  // Decode in chunks to avoid "call stack size exceeded".
  var res = ''
  var i = 0
  while (i < len) {
    res += String.fromCharCode.apply(
      String,
      codePoints.slice(i, i += MAX_ARGUMENTS_LENGTH)
    )
  }
  return res
}

function asciiSlice (buf, start, end) {
  var ret = ''
  end = Math.min(buf.length, end)

  for (var i = start; i < end; ++i) {
    ret += String.fromCharCode(buf[i] & 0x7F)
  }
  return ret
}

function latin1Slice (buf, start, end) {
  var ret = ''
  end = Math.min(buf.length, end)

  for (var i = start; i < end; ++i) {
    ret += String.fromCharCode(buf[i])
  }
  return ret
}

function hexSlice (buf, start, end) {
  var len = buf.length

  if (!start || start < 0) start = 0
  if (!end || end < 0 || end > len) end = len

  var out = ''
  for (var i = start; i < end; ++i) {
    out += toHex(buf[i])
  }
  return out
}

function utf16leSlice (buf, start, end) {
  var bytes = buf.slice(start, end)
  var res = ''
  for (var i = 0; i < bytes.length; i += 2) {
    res += String.fromCharCode(bytes[i] + (bytes[i + 1] * 256))
  }
  return res
}

Buffer.prototype.slice = function slice (start, end) {
  var len = this.length
  start = ~~start
  end = end === undefined ? len : ~~end

  if (start < 0) {
    start += len
    if (start < 0) start = 0
  } else if (start > len) {
    start = len
  }

  if (end < 0) {
    end += len
    if (end < 0) end = 0
  } else if (end > len) {
    end = len
  }

  if (end < start) end = start

  var newBuf = this.subarray(start, end)
  // Return an augmented `Uint8Array` instance
  newBuf.__proto__ = Buffer.prototype
  return newBuf
}

/*
 * Need to make sure that buffer isn't trying to write out of bounds.
 */
function checkOffset (offset, ext, length) {
  if ((offset % 1) !== 0 || offset < 0) throw new RangeError('offset is not uint')
  if (offset + ext > length) throw new RangeError('Trying to access beyond buffer length')
}

Buffer.prototype.readUIntLE = function readUIntLE (offset, byteLength, noAssert) {
  offset = offset >>> 0
  byteLength = byteLength >>> 0
  if (!noAssert) checkOffset(offset, byteLength, this.length)

  var val = this[offset]
  var mul = 1
  var i = 0
  while (++i < byteLength && (mul *= 0x100)) {
    val += this[offset + i] * mul
  }

  return val
}

Buffer.prototype.readUIntBE = function readUIntBE (offset, byteLength, noAssert) {
  offset = offset >>> 0
  byteLength = byteLength >>> 0
  if (!noAssert) {
    checkOffset(offset, byteLength, this.length)
  }

  var val = this[offset + --byteLength]
  var mul = 1
  while (byteLength > 0 && (mul *= 0x100)) {
    val += this[offset + --byteLength] * mul
  }

  return val
}

Buffer.prototype.readUInt8 = function readUInt8 (offset, noAssert) {
  offset = offset >>> 0
  if (!noAssert) checkOffset(offset, 1, this.length)
  return this[offset]
}

Buffer.prototype.readUInt16LE = function readUInt16LE (offset, noAssert) {
  offset = offset >>> 0
  if (!noAssert) checkOffset(offset, 2, this.length)
  return this[offset] | (this[offset + 1] << 8)
}

Buffer.prototype.readUInt16BE = function readUInt16BE (offset, noAssert) {
  offset = offset >>> 0
  if (!noAssert) checkOffset(offset, 2, this.length)
  return (this[offset] << 8) | this[offset + 1]
}

Buffer.prototype.readUInt32LE = function readUInt32LE (offset, noAssert) {
  offset = offset >>> 0
  if (!noAssert) checkOffset(offset, 4, this.length)

  return ((this[offset]) |
      (this[offset + 1] << 8) |
      (this[offset + 2] << 16)) +
      (this[offset + 3] * 0x1000000)
}

Buffer.prototype.readUInt32BE = function readUInt32BE (offset, noAssert) {
  offset = offset >>> 0
  if (!noAssert) checkOffset(offset, 4, this.length)

  return (this[offset] * 0x1000000) +
    ((this[offset + 1] << 16) |
    (this[offset + 2] << 8) |
    this[offset + 3])
}

Buffer.prototype.readIntLE = function readIntLE (offset, byteLength, noAssert) {
  offset = offset >>> 0
  byteLength = byteLength >>> 0
  if (!noAssert) checkOffset(offset, byteLength, this.length)

  var val = this[offset]
  var mul = 1
  var i = 0
  while (++i < byteLength && (mul *= 0x100)) {
    val += this[offset + i] * mul
  }
  mul *= 0x80

  if (val >= mul) val -= Math.pow(2, 8 * byteLength)

  return val
}

Buffer.prototype.readIntBE = function readIntBE (offset, byteLength, noAssert) {
  offset = offset >>> 0
  byteLength = byteLength >>> 0
  if (!noAssert) checkOffset(offset, byteLength, this.length)

  var i = byteLength
  var mul = 1
  var val = this[offset + --i]
  while (i > 0 && (mul *= 0x100)) {
    val += this[offset + --i] * mul
  }
  mul *= 0x80

  if (val >= mul) val -= Math.pow(2, 8 * byteLength)

  return val
}

Buffer.prototype.readInt8 = function readInt8 (offset, noAssert) {
  offset = offset >>> 0
  if (!noAssert) checkOffset(offset, 1, this.length)
  if (!(this[offset] & 0x80)) return (this[offset])
  return ((0xff - this[offset] + 1) * -1)
}

Buffer.prototype.readInt16LE = function readInt16LE (offset, noAssert) {
  offset = offset >>> 0
  if (!noAssert) checkOffset(offset, 2, this.length)
  var val = this[offset] | (this[offset + 1] << 8)
  return (val & 0x8000) ? val | 0xFFFF0000 : val
}

Buffer.prototype.readInt16BE = function readInt16BE (offset, noAssert) {
  offset = offset >>> 0
  if (!noAssert) checkOffset(offset, 2, this.length)
  var val = this[offset + 1] | (this[offset] << 8)
  return (val & 0x8000) ? val | 0xFFFF0000 : val
}

Buffer.prototype.readInt32LE = function readInt32LE (offset, noAssert) {
  offset = offset >>> 0
  if (!noAssert) checkOffset(offset, 4, this.length)

  return (this[offset]) |
    (this[offset + 1] << 8) |
    (this[offset + 2] << 16) |
    (this[offset + 3] << 24)
}

Buffer.prototype.readInt32BE = function readInt32BE (offset, noAssert) {
  offset = offset >>> 0
  if (!noAssert) checkOffset(offset, 4, this.length)

  return (this[offset] << 24) |
    (this[offset + 1] << 16) |
    (this[offset + 2] << 8) |
    (this[offset + 3])
}

Buffer.prototype.readFloatLE = function readFloatLE (offset, noAssert) {
  offset = offset >>> 0
  if (!noAssert) checkOffset(offset, 4, this.length)
  return ieee754.read(this, offset, true, 23, 4)
}

Buffer.prototype.readFloatBE = function readFloatBE (offset, noAssert) {
  offset = offset >>> 0
  if (!noAssert) checkOffset(offset, 4, this.length)
  return ieee754.read(this, offset, false, 23, 4)
}

Buffer.prototype.readDoubleLE = function readDoubleLE (offset, noAssert) {
  offset = offset >>> 0
  if (!noAssert) checkOffset(offset, 8, this.length)
  return ieee754.read(this, offset, true, 52, 8)
}

Buffer.prototype.readDoubleBE = function readDoubleBE (offset, noAssert) {
  offset = offset >>> 0
  if (!noAssert) checkOffset(offset, 8, this.length)
  return ieee754.read(this, offset, false, 52, 8)
}

function checkInt (buf, value, offset, ext, max, min) {
  if (!Buffer.isBuffer(buf)) throw new TypeError('"buffer" argument must be a Buffer instance')
  if (value > max || value < min) throw new RangeError('"value" argument is out of bounds')
  if (offset + ext > buf.length) throw new RangeError('Index out of range')
}

Buffer.prototype.writeUIntLE = function writeUIntLE (value, offset, byteLength, noAssert) {
  value = +value
  offset = offset >>> 0
  byteLength = byteLength >>> 0
  if (!noAssert) {
    var maxBytes = Math.pow(2, 8 * byteLength) - 1
    checkInt(this, value, offset, byteLength, maxBytes, 0)
  }

  var mul = 1
  var i = 0
  this[offset] = value & 0xFF
  while (++i < byteLength && (mul *= 0x100)) {
    this[offset + i] = (value / mul) & 0xFF
  }

  return offset + byteLength
}

Buffer.prototype.writeUIntBE = function writeUIntBE (value, offset, byteLength, noAssert) {
  value = +value
  offset = offset >>> 0
  byteLength = byteLength >>> 0
  if (!noAssert) {
    var maxBytes = Math.pow(2, 8 * byteLength) - 1
    checkInt(this, value, offset, byteLength, maxBytes, 0)
  }

  var i = byteLength - 1
  var mul = 1
  this[offset + i] = value & 0xFF
  while (--i >= 0 && (mul *= 0x100)) {
    this[offset + i] = (value / mul) & 0xFF
  }

  return offset + byteLength
}

Buffer.prototype.writeUInt8 = function writeUInt8 (value, offset, noAssert) {
  value = +value
  offset = offset >>> 0
  if (!noAssert) checkInt(this, value, offset, 1, 0xff, 0)
  this[offset] = (value & 0xff)
  return offset + 1
}

Buffer.prototype.writeUInt16LE = function writeUInt16LE (value, offset, noAssert) {
  value = +value
  offset = offset >>> 0
  if (!noAssert) checkInt(this, value, offset, 2, 0xffff, 0)
  this[offset] = (value & 0xff)
  this[offset + 1] = (value >>> 8)
  return offset + 2
}

Buffer.prototype.writeUInt16BE = function writeUInt16BE (value, offset, noAssert) {
  value = +value
  offset = offset >>> 0
  if (!noAssert) checkInt(this, value, offset, 2, 0xffff, 0)
  this[offset] = (value >>> 8)
  this[offset + 1] = (value & 0xff)
  return offset + 2
}

Buffer.prototype.writeUInt32LE = function writeUInt32LE (value, offset, noAssert) {
  value = +value
  offset = offset >>> 0
  if (!noAssert) checkInt(this, value, offset, 4, 0xffffffff, 0)
  this[offset + 3] = (value >>> 24)
  this[offset + 2] = (value >>> 16)
  this[offset + 1] = (value >>> 8)
  this[offset] = (value & 0xff)
  return offset + 4
}

Buffer.prototype.writeUInt32BE = function writeUInt32BE (value, offset, noAssert) {
  value = +value
  offset = offset >>> 0
  if (!noAssert) checkInt(this, value, offset, 4, 0xffffffff, 0)
  this[offset] = (value >>> 24)
  this[offset + 1] = (value >>> 16)
  this[offset + 2] = (value >>> 8)
  this[offset + 3] = (value & 0xff)
  return offset + 4
}

Buffer.prototype.writeIntLE = function writeIntLE (value, offset, byteLength, noAssert) {
  value = +value
  offset = offset >>> 0
  if (!noAssert) {
    var limit = Math.pow(2, (8 * byteLength) - 1)

    checkInt(this, value, offset, byteLength, limit - 1, -limit)
  }

  var i = 0
  var mul = 1
  var sub = 0
  this[offset] = value & 0xFF
  while (++i < byteLength && (mul *= 0x100)) {
    if (value < 0 && sub === 0 && this[offset + i - 1] !== 0) {
      sub = 1
    }
    this[offset + i] = ((value / mul) >> 0) - sub & 0xFF
  }

  return offset + byteLength
}

Buffer.prototype.writeIntBE = function writeIntBE (value, offset, byteLength, noAssert) {
  value = +value
  offset = offset >>> 0
  if (!noAssert) {
    var limit = Math.pow(2, (8 * byteLength) - 1)

    checkInt(this, value, offset, byteLength, limit - 1, -limit)
  }

  var i = byteLength - 1
  var mul = 1
  var sub = 0
  this[offset + i] = value & 0xFF
  while (--i >= 0 && (mul *= 0x100)) {
    if (value < 0 && sub === 0 && this[offset + i + 1] !== 0) {
      sub = 1
    }
    this[offset + i] = ((value / mul) >> 0) - sub & 0xFF
  }

  return offset + byteLength
}

Buffer.prototype.writeInt8 = function writeInt8 (value, offset, noAssert) {
  value = +value
  offset = offset >>> 0
  if (!noAssert) checkInt(this, value, offset, 1, 0x7f, -0x80)
  if (value < 0) value = 0xff + value + 1
  this[offset] = (value & 0xff)
  return offset + 1
}

Buffer.prototype.writeInt16LE = function writeInt16LE (value, offset, noAssert) {
  value = +value
  offset = offset >>> 0
  if (!noAssert) checkInt(this, value, offset, 2, 0x7fff, -0x8000)
  this[offset] = (value & 0xff)
  this[offset + 1] = (value >>> 8)
  return offset + 2
}

Buffer.prototype.writeInt16BE = function writeInt16BE (value, offset, noAssert) {
  value = +value
  offset = offset >>> 0
  if (!noAssert) checkInt(this, value, offset, 2, 0x7fff, -0x8000)
  this[offset] = (value >>> 8)
  this[offset + 1] = (value & 0xff)
  return offset + 2
}

Buffer.prototype.writeInt32LE = function writeInt32LE (value, offset, noAssert) {
  value = +value
  offset = offset >>> 0
  if (!noAssert) checkInt(this, value, offset, 4, 0x7fffffff, -0x80000000)
  this[offset] = (value & 0xff)
  this[offset + 1] = (value >>> 8)
  this[offset + 2] = (value >>> 16)
  this[offset + 3] = (value >>> 24)
  return offset + 4
}

Buffer.prototype.writeInt32BE = function writeInt32BE (value, offset, noAssert) {
  value = +value
  offset = offset >>> 0
  if (!noAssert) checkInt(this, value, offset, 4, 0x7fffffff, -0x80000000)
  if (value < 0) value = 0xffffffff + value + 1
  this[offset] = (value >>> 24)
  this[offset + 1] = (value >>> 16)
  this[offset + 2] = (value >>> 8)
  this[offset + 3] = (value & 0xff)
  return offset + 4
}

function checkIEEE754 (buf, value, offset, ext, max, min) {
  if (offset + ext > buf.length) throw new RangeError('Index out of range')
  if (offset < 0) throw new RangeError('Index out of range')
}

function writeFloat (buf, value, offset, littleEndian, noAssert) {
  value = +value
  offset = offset >>> 0
  if (!noAssert) {
    checkIEEE754(buf, value, offset, 4, 3.4028234663852886e+38, -3.4028234663852886e+38)
  }
  ieee754.write(buf, value, offset, littleEndian, 23, 4)
  return offset + 4
}

Buffer.prototype.writeFloatLE = function writeFloatLE (value, offset, noAssert) {
  return writeFloat(this, value, offset, true, noAssert)
}

Buffer.prototype.writeFloatBE = function writeFloatBE (value, offset, noAssert) {
  return writeFloat(this, value, offset, false, noAssert)
}

function writeDouble (buf, value, offset, littleEndian, noAssert) {
  value = +value
  offset = offset >>> 0
  if (!noAssert) {
    checkIEEE754(buf, value, offset, 8, 1.7976931348623157E+308, -1.7976931348623157E+308)
  }
  ieee754.write(buf, value, offset, littleEndian, 52, 8)
  return offset + 8
}

Buffer.prototype.writeDoubleLE = function writeDoubleLE (value, offset, noAssert) {
  return writeDouble(this, value, offset, true, noAssert)
}

Buffer.prototype.writeDoubleBE = function writeDoubleBE (value, offset, noAssert) {
  return writeDouble(this, value, offset, false, noAssert)
}

// copy(targetBuffer, targetStart=0, sourceStart=0, sourceEnd=buffer.length)
Buffer.prototype.copy = function copy (target, targetStart, start, end) {
  if (!Buffer.isBuffer(target)) throw new TypeError('argument should be a Buffer')
  if (!start) start = 0
  if (!end && end !== 0) end = this.length
  if (targetStart >= target.length) targetStart = target.length
  if (!targetStart) targetStart = 0
  if (end > 0 && end < start) end = start

  // Copy 0 bytes; we're done
  if (end === start) return 0
  if (target.length === 0 || this.length === 0) return 0

  // Fatal error conditions
  if (targetStart < 0) {
    throw new RangeError('targetStart out of bounds')
  }
  if (start < 0 || start >= this.length) throw new RangeError('Index out of range')
  if (end < 0) throw new RangeError('sourceEnd out of bounds')

  // Are we oob?
  if (end > this.length) end = this.length
  if (target.length - targetStart < end - start) {
    end = target.length - targetStart + start
  }

  var len = end - start

  if (this === target && typeof Uint8Array.prototype.copyWithin === 'function') {
    // Use built-in when available, missing from IE11
    this.copyWithin(targetStart, start, end)
  } else if (this === target && start < targetStart && targetStart < end) {
    // descending copy from end
    for (var i = len - 1; i >= 0; --i) {
      target[i + targetStart] = this[i + start]
    }
  } else {
    Uint8Array.prototype.set.call(
      target,
      this.subarray(start, end),
      targetStart
    )
  }

  return len
}

// Usage:
//    buffer.fill(number[, offset[, end]])
//    buffer.fill(buffer[, offset[, end]])
//    buffer.fill(string[, offset[, end]][, encoding])
Buffer.prototype.fill = function fill (val, start, end, encoding) {
  // Handle string cases:
  if (typeof val === 'string') {
    if (typeof start === 'string') {
      encoding = start
      start = 0
      end = this.length
    } else if (typeof end === 'string') {
      encoding = end
      end = this.length
    }
    if (encoding !== undefined && typeof encoding !== 'string') {
      throw new TypeError('encoding must be a string')
    }
    if (typeof encoding === 'string' && !Buffer.isEncoding(encoding)) {
      throw new TypeError('Unknown encoding: ' + encoding)
    }
    if (val.length === 1) {
      var code = val.charCodeAt(0)
      if ((encoding === 'utf8' && code < 128) ||
          encoding === 'latin1') {
        // Fast path: If `val` fits into a single byte, use that numeric value.
        val = code
      }
    }
  } else if (typeof val === 'number') {
    val = val & 255
  }

  // Invalid ranges are not set to a default, so can range check early.
  if (start < 0 || this.length < start || this.length < end) {
    throw new RangeError('Out of range index')
  }

  if (end <= start) {
    return this
  }

  start = start >>> 0
  end = end === undefined ? this.length : end >>> 0

  if (!val) val = 0

  var i
  if (typeof val === 'number') {
    for (i = start; i < end; ++i) {
      this[i] = val
    }
  } else {
    var bytes = Buffer.isBuffer(val)
      ? val
      : Buffer.from(val, encoding)
    var len = bytes.length
    if (len === 0) {
      throw new TypeError('The value "' + val +
        '" is invalid for argument "value"')
    }
    for (i = 0; i < end - start; ++i) {
      this[i + start] = bytes[i % len]
    }
  }

  return this
}

// HELPER FUNCTIONS
// ================

var INVALID_BASE64_RE = /[^+/0-9A-Za-z-_]/g

function base64clean (str) {
  // Node takes equal signs as end of the Base64 encoding
  str = str.split('=')[0]
  // Node strips out invalid characters like \n and \t from the string, base64-js does not
  str = str.trim().replace(INVALID_BASE64_RE, '')
  // Node converts strings with length < 2 to ''
  if (str.length < 2) return ''
  // Node allows for non-padded base64 strings (missing trailing ===), base64-js does not
  while (str.length % 4 !== 0) {
    str = str + '='
  }
  return str
}

function toHex (n) {
  if (n < 16) return '0' + n.toString(16)
  return n.toString(16)
}

function utf8ToBytes (string, units) {
  units = units || Infinity
  var codePoint
  var length = string.length
  var leadSurrogate = null
  var bytes = []

  for (var i = 0; i < length; ++i) {
    codePoint = string.charCodeAt(i)

    // is surrogate component
    if (codePoint > 0xD7FF && codePoint < 0xE000) {
      // last char was a lead
      if (!leadSurrogate) {
        // no lead yet
        if (codePoint > 0xDBFF) {
          // unexpected trail
          if ((units -= 3) > -1) bytes.push(0xEF, 0xBF, 0xBD)
          continue
        } else if (i + 1 === length) {
          // unpaired lead
          if ((units -= 3) > -1) bytes.push(0xEF, 0xBF, 0xBD)
          continue
        }

        // valid lead
        leadSurrogate = codePoint

        continue
      }

      // 2 leads in a row
      if (codePoint < 0xDC00) {
        if ((units -= 3) > -1) bytes.push(0xEF, 0xBF, 0xBD)
        leadSurrogate = codePoint
        continue
      }

      // valid surrogate pair
      codePoint = (leadSurrogate - 0xD800 << 10 | codePoint - 0xDC00) + 0x10000
    } else if (leadSurrogate) {
      // valid bmp char, but last char was a lead
      if ((units -= 3) > -1) bytes.push(0xEF, 0xBF, 0xBD)
    }

    leadSurrogate = null

    // encode utf8
    if (codePoint < 0x80) {
      if ((units -= 1) < 0) break
      bytes.push(codePoint)
    } else if (codePoint < 0x800) {
      if ((units -= 2) < 0) break
      bytes.push(
        codePoint >> 0x6 | 0xC0,
        codePoint & 0x3F | 0x80
      )
    } else if (codePoint < 0x10000) {
      if ((units -= 3) < 0) break
      bytes.push(
        codePoint >> 0xC | 0xE0,
        codePoint >> 0x6 & 0x3F | 0x80,
        codePoint & 0x3F | 0x80
      )
    } else if (codePoint < 0x110000) {
      if ((units -= 4) < 0) break
      bytes.push(
        codePoint >> 0x12 | 0xF0,
        codePoint >> 0xC & 0x3F | 0x80,
        codePoint >> 0x6 & 0x3F | 0x80,
        codePoint & 0x3F | 0x80
      )
    } else {
      throw new Error('Invalid code point')
    }
  }

  return bytes
}

function asciiToBytes (str) {
  var byteArray = []
  for (var i = 0; i < str.length; ++i) {
    // Node's code seems to be doing this and not & 0x7F..
    byteArray.push(str.charCodeAt(i) & 0xFF)
  }
  return byteArray
}

function utf16leToBytes (str, units) {
  var c, hi, lo
  var byteArray = []
  for (var i = 0; i < str.length; ++i) {
    if ((units -= 2) < 0) break

    c = str.charCodeAt(i)
    hi = c >> 8
    lo = c % 256
    byteArray.push(lo)
    byteArray.push(hi)
  }

  return byteArray
}

function base64ToBytes (str) {
  return base64.toByteArray(base64clean(str))
}

function blitBuffer (src, dst, offset, length) {
  for (var i = 0; i < length; ++i) {
    if ((i + offset >= dst.length) || (i >= src.length)) break
    dst[i + offset] = src[i]
  }
  return i
}

// ArrayBuffer or Uint8Array objects from other contexts (i.e. iframes) do not pass
// the `instanceof` check but they should be treated as of that type.
// See: https://github.com/feross/buffer/issues/166
function isInstance (obj, type) {
  return obj instanceof type ||
    (obj != null && obj.constructor != null && obj.constructor.name != null &&
      obj.constructor.name === type.name)
}
function numberIsNaN (obj) {
  // For IE11 support
  return obj !== obj // eslint-disable-line no-self-compare
}

},{"base64-js":5,"ieee754":13}],7:[function(require,module,exports){
var charenc = {
  // UTF-8 encoding
  utf8: {
    // Convert a string to a byte array
    stringToBytes: function(str) {
      return charenc.bin.stringToBytes(unescape(encodeURIComponent(str)));
    },

    // Convert a byte array to a string
    bytesToString: function(bytes) {
      return decodeURIComponent(escape(charenc.bin.bytesToString(bytes)));
    }
  },

  // Binary encoding
  bin: {
    // Convert a string to a byte array
    stringToBytes: function(str) {
      for (var bytes = [], i = 0; i < str.length; i++)
        bytes.push(str.charCodeAt(i) & 0xFF);
      return bytes;
    },

    // Convert a byte array to a string
    bytesToString: function(bytes) {
      for (var str = [], i = 0; i < bytes.length; i++)
        str.push(String.fromCharCode(bytes[i]));
      return str.join('');
    }
  }
};

module.exports = charenc;

},{}],8:[function(require,module,exports){
/** Wrap an API that uses callbacks with Promises
 * This expects the pattern function withCallback(arg1, arg2, ... argN, callback)
 * @author Keith Henry <keith.henry@evolutionjobs.co.uk>
 * @license MIT */
(function () {
    'use strict';

    /** Wrap a function with a callback with a Promise.
     * @param {function} f The function to wrap, should be pattern: withCallback(arg1, arg2, ... argN, callback).
     * @param {function} parseCB Optional function to parse multiple callback parameters into a single object.
     * @returns {Promise} Promise that resolves when the callback fires. */
    function promisify(f, parseCB) {
        return (...args) => {
            let safeArgs = args;
            let callback;
            // The Chrome API functions all use arguments, so we can't use f.length to check

            // If there is a last arg
            if (args && args.length > 0) {

                // ... and the last arg is a function
                const last = args[args.length - 1];
                if (typeof last === 'function') {
                    // Trim the last callback arg if it's been passed
                    safeArgs = args.slice(0, args.length - 1);
                    callback = last;
                }
            }

            // Return a promise
            return new Promise((resolve, reject) => {
                try {
                    // Try to run the original function, with the trimmed args list
                    f(...safeArgs, (...cbArgs) => {

                        // If a callback was passed at the end of the original arguments
                        if (callback) {
                            // Don't allow a bug in the callback to stop the promise resolving
                            try { callback(...cbArgs); }
                            catch (cbErr) { reject(cbErr); }
                        }

                        // Chrome extensions always fire the callback, but populate chrome.runtime.lastError with exception details
                        if (chrome.runtime.lastError)
                            // Return as an error for the awaited catch block
                            reject(new Error(chrome.runtime.lastError.message || `Error thrown by API ${chrome.runtime.lastError}`));
                        else {
                            if (parseCB) {
                                const cbObj = parseCB(...cbArgs);
                                resolve(cbObj);
                            }
                            else if (!cbArgs || cbArgs.length === 0)
                                resolve();
                            else if (cbArgs.length === 1)
                                resolve(cbArgs[0]);
                            else
                                resolve(cbArgs);
                        }
                    });
                }
                catch (err) { reject(err); }
            });
        }
    }

    /** Promisify all the known functions in the map 
     * @param {object} api The Chrome native API to extend
     * @param {Array} apiMap Collection of sub-API and functions to promisify */
    function applyMap(api, apiMap) {
        if (!api)
            // Not supported by current permissions
            return;

        for (let funcDef of apiMap) {
            let funcName;
            if (typeof funcDef === 'string')
                funcName = funcDef;
            else {
                funcName = funcDef.n;
            }

            if (!api.hasOwnProperty(funcName))
                // Member not in API
                continue;

            const m = api[funcName];
            if (typeof m === 'function')
                // This is a function, wrap in a promise
                api[funcName] = promisify(m.bind(api), funcDef.cb);
            else
                // Sub-API, recurse this func with the mapped props
                applyMap(m, funcDef.props);
        }
    }

    /** Apply promise-maps to the Chrome native API.
     * @param {object} apiMaps The API to apply. */
    function applyMaps(apiMaps) {
        for (let apiName in apiMaps) {
            const callbackApi = chrome[apiName];
            if (!callbackApi)
                // Not supported by current permissions
                continue;

            const apiMap = apiMaps[apiName];
            applyMap(callbackApi, apiMap);
        }
    }

    // accessibilityFeatures https://developer.chrome.com/extensions/accessibilityFeatures
    const knownA11ySetting = ['get', 'set', 'clear'];

    // ContentSetting https://developer.chrome.com/extensions/contentSettings#type-ContentSetting
    const knownInContentSetting = ['clear', 'get', 'set', 'getResourceIdentifiers'];

    // StorageArea https://developer.chrome.com/extensions/storage#type-StorageArea
    const knownInStorageArea = ['get', 'getBytesInUse', 'set', 'remove', 'clear'];

    /** Map of API functions that follow the callback pattern that we can 'promisify' */
    applyMaps({
        accessibilityFeatures: [  // Todo: this should extend AccessibilityFeaturesSetting.prototype instead
            { n: 'spokenFeedback', props: knownA11ySetting },
            { n: 'largeCursor', props: knownA11ySetting },
            { n: 'stickyKeys', props: knownA11ySetting },
            { n: 'highContrast', props: knownA11ySetting },
            { n: 'screenMagnifier', props: knownA11ySetting },
            { n: 'autoclick', props: knownA11ySetting },
            { n: 'virtualKeyboard', props: knownA11ySetting },
            { n: 'animationPolicy', props: knownA11ySetting }],
        alarms: ['get', 'getAll', 'clear', 'clearAll'],
        bookmarks: [
            'get', 'getChildren', 'getRecent', 'getTree', 'getSubTree',
            'search', 'create', 'move', 'update', 'remove', 'removeTree'],
        browser: ['openTab'],
        browserAction: [
            'getTitle', 'setIcon', 'getPopup', 'getBadgeText', 'getBadgeBackgroundColor'],
        browsingData: [
            'settings', 'remove', 'removeAppcache', 'removeCache',
            'removeCookies', 'removeDownloads', 'removeFileSystems',
            'removeFormData', 'removeHistory', 'removeIndexedDB',
            'removeLocalStorage', 'removePluginData', 'removePasswords',
            'removeWebSQL'],
        commands: ['getAll'],
        contentSettings: [  // Todo: this should extend ContentSetting.prototype instead
            { n: 'cookies', props: knownInContentSetting },
            { n: 'images', props: knownInContentSetting },
            { n: 'javascript', props: knownInContentSetting },
            { n: 'location', props: knownInContentSetting },
            { n: 'plugins', props: knownInContentSetting },
            { n: 'popups', props: knownInContentSetting },
            { n: 'notifications', props: knownInContentSetting },
            { n: 'fullscreen', props: knownInContentSetting },
            { n: 'mouselock', props: knownInContentSetting },
            { n: 'microphone', props: knownInContentSetting },
            { n: 'camera', props: knownInContentSetting },
            { n: 'unsandboxedPlugins', props: knownInContentSetting },
            { n: 'automaticDownloads', props: knownInContentSetting }],
        contextMenus: ['create', 'update', 'remove', 'removeAll'],
        cookies: ['get', 'getAll', 'set', 'remove', 'getAllCookieStores'],
        debugger: ['attach', 'detach', 'sendCommand', 'getTargets'],
        desktopCapture: ['chooseDesktopMedia'],
        // TODO: devtools.*
        documentScan: ['scan'],
        downloads: [
            'download', 'search', 'pause', 'resume', 'cancel',
            'getFileIcon', 'erase', 'removeFile', 'acceptDanger'],
        enterprise: [{ n: 'platformKeys', props: ['getToken', 'getCertificates', 'importCertificate', 'removeCertificate'] }],
        extension: ['isAllowedIncognitoAccess', 'isAllowedFileSchemeAccess'], // mostly deprecated in favour of runtime
        fileBrowserHandler: ['selectFile'],
        fileSystemProvider: ['mount', 'unmount', 'getAll', 'get', 'notify'],
        fontSettings: [
            'setDefaultFontSize', 'getFont', 'getDefaultFontSize', 'getMinimumFontSize',
            'setMinimumFontSize', 'getDefaultFixedFontSize', 'clearDefaultFontSize',
            'setDefaultFixedFontSize', 'clearFont', 'setFont', 'clearMinimumFontSize',
            'getFontList', 'clearDefaultFixedFontSize'],
        gcm: ['register', 'unregister', 'send'],
        history: ['search', 'getVisits', 'addUrl', 'deleteUrl', 'deleteRange', 'deleteAll'],
        i18n: ['getAcceptLanguages', 'detectLanguage'],
        identity: [
            'getAuthToken', 'getProfileUserInfo', 'removeCachedAuthToken', 'launchWebAuthFlow'],
        idle: ['queryState'],
        input: [{
            n: 'ime', props: [
                'setMenuItems', 'commitText', 'setCandidates', 'setComposition', 'updateMenuItems',
                'setCandidateWindowProperties', 'clearComposition', 'setCursorPosition', 'sendKeyEvents',
                'deleteSurroundingText']
        }],
        management: [
            'setEnabled', 'getPermissionWarningsById', 'get', 'getAll',
            'getPermissionWarningsByManifest', 'launchApp', 'uninstall', 'getSelf',
            'uninstallSelf', 'createAppShortcut', 'setLaunchType', 'generateAppForLink'],
        networking: [{ n: 'config', props: ['setNetworkFilter', 'finishAuthentication'] }],
        notifications: ['create', 'update', 'clear', 'getAll', 'getPermissionLevel'],
        pageAction: ['getTitle', 'setIcon', 'getPopup'],
        pageCapture: ['saveAsMHTML'],
        permissions: ['getAll', 'contains', 'request', 'remove'],
        platformKeys: ['selectClientCertificates', 'verifyTLSServerCertificate',
            { n: "getKeyPair", cb: (publicKey, privateKey) => { return { publicKey, privateKey }; } }],
        runtime: [
            'getBackgroundPage', 'openOptionsPage', 'setUninstallURL',
            'restartAfterDelay', 'sendMessage',
            'sendNativeMessage', 'getPlatformInfo', 'getPackageDirectoryEntry',
            { n: "requestUpdateCheck", cb: (status, details) => { return { status, details }; } }],
        scriptBadge: ['getPopup'],
        sessions: ['getRecentlyClosed', 'getDevices', 'restore'],
        storage: [          // Todo: this should extend StorageArea.prototype instead
            { n: 'sync', props: knownInStorageArea },
            { n: 'local', props: knownInStorageArea },
            { n: 'managed', props: knownInStorageArea }],
        socket: [
            'create', 'connect', 'bind', 'read', 'write', 'recvFrom', 'sendTo',
            'listen', 'accept', 'setKeepAlive', 'setNoDelay', 'getInfo', 'getNetworkList'],
        sockets: [
            { n: 'tcp', props: [
                'create','update','setPaused','setKeepAlive','setNoDelay','connect',
                'disconnect','secure','send','close','getInfo','getSockets'] },
            { n: 'tcpServer', props: [
                'create','update','setPaused','listen','disconnect','close','getInfo','getSockets'] }, 
            { n: 'udp', props: [
                'create','update','setPaused','bind','send','close','getInfo',
                'getSockets','joinGroup','leaveGroup','setMulticastTimeToLive',
                'setMulticastLoopbackMode','getJoinedGroups','setBroadcast'] }],
        system: [
            { n: 'cpu', props: ['getInfo'] },
            { n: 'memory', props: ['getInfo'] },
            { n: 'storage', props: ['getInfo', 'ejectDevice', 'getAvailableCapacity'] }],
        tabCapture: ['capture', 'getCapturedTabs'],
        tabs: [
            'get', 'getCurrent', 'sendMessage', 'create', 'duplicate',
            'query', 'highlight', 'update', 'move', 'reload', 'remove',
            'detectLanguage', 'captureVisibleTab', 'executeScript',
            'insertCSS', 'setZoom', 'getZoom', 'setZoomSettings',
            'getZoomSettings', 'discard'],
        topSites: ['get'],
        tts: ['isSpeaking', 'getVoices', 'speak'],
        types: ['set', 'get', 'clear'],
        vpnProvider: ['createConfig', 'destroyConfig', 'setParameters', 'sendPacket', 'notifyConnectionStateChanged'],
        wallpaper: ['setWallpaper'],
        webNavigation: ['getFrame', 'getAllFrames', 'handlerBehaviorChanged'],
        windows: ['get', 'getCurrent', 'getLastFocused', 'getAll', 'create', 'update', 'remove']
    });
})();

},{}],9:[function(require,module,exports){
(function() {
  var base64map
      = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/',

  crypt = {
    // Bit-wise rotation left
    rotl: function(n, b) {
      return (n << b) | (n >>> (32 - b));
    },

    // Bit-wise rotation right
    rotr: function(n, b) {
      return (n << (32 - b)) | (n >>> b);
    },

    // Swap big-endian to little-endian and vice versa
    endian: function(n) {
      // If number given, swap endian
      if (n.constructor == Number) {
        return crypt.rotl(n, 8) & 0x00FF00FF | crypt.rotl(n, 24) & 0xFF00FF00;
      }

      // Else, assume array and swap all items
      for (var i = 0; i < n.length; i++)
        n[i] = crypt.endian(n[i]);
      return n;
    },

    // Generate an array of any length of random bytes
    randomBytes: function(n) {
      for (var bytes = []; n > 0; n--)
        bytes.push(Math.floor(Math.random() * 256));
      return bytes;
    },

    // Convert a byte array to big-endian 32-bit words
    bytesToWords: function(bytes) {
      for (var words = [], i = 0, b = 0; i < bytes.length; i++, b += 8)
        words[b >>> 5] |= bytes[i] << (24 - b % 32);
      return words;
    },

    // Convert big-endian 32-bit words to a byte array
    wordsToBytes: function(words) {
      for (var bytes = [], b = 0; b < words.length * 32; b += 8)
        bytes.push((words[b >>> 5] >>> (24 - b % 32)) & 0xFF);
      return bytes;
    },

    // Convert a byte array to a hex string
    bytesToHex: function(bytes) {
      for (var hex = [], i = 0; i < bytes.length; i++) {
        hex.push((bytes[i] >>> 4).toString(16));
        hex.push((bytes[i] & 0xF).toString(16));
      }
      return hex.join('');
    },

    // Convert a hex string to a byte array
    hexToBytes: function(hex) {
      for (var bytes = [], c = 0; c < hex.length; c += 2)
        bytes.push(parseInt(hex.substr(c, 2), 16));
      return bytes;
    },

    // Convert a byte array to a base-64 string
    bytesToBase64: function(bytes) {
      for (var base64 = [], i = 0; i < bytes.length; i += 3) {
        var triplet = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
        for (var j = 0; j < 4; j++)
          if (i * 8 + j * 6 <= bytes.length * 8)
            base64.push(base64map.charAt((triplet >>> 6 * (3 - j)) & 0x3F));
          else
            base64.push('=');
      }
      return base64.join('');
    },

    // Convert a base-64 string to a byte array
    base64ToBytes: function(base64) {
      // Remove non-base-64 characters
      base64 = base64.replace(/[^A-Z0-9+\/]/ig, '');

      for (var bytes = [], i = 0, imod4 = 0; i < base64.length;
          imod4 = ++i % 4) {
        if (imod4 == 0) continue;
        bytes.push(((base64map.indexOf(base64.charAt(i - 1))
            & (Math.pow(2, -2 * imod4 + 8) - 1)) << (imod4 * 2))
            | (base64map.indexOf(base64.charAt(i)) >>> (6 - imod4 * 2)));
      }
      return bytes;
    }
  };

  module.exports = crypt;
})();

},{}],10:[function(require,module,exports){
(function (setImmediate){
/*
WHAT: SublimeText-like Fuzzy Search

USAGE:
  fuzzysort.single('fs', 'Fuzzy Search') // {score: -16}
  fuzzysort.single('test', 'test') // {score: 0}
  fuzzysort.single('doesnt exist', 'target') // null

  fuzzysort.go('mr', ['Monitor.cpp', 'MeshRenderer.cpp'])
  // [{score: -18, target: "MeshRenderer.cpp"}, {score: -6009, target: "Monitor.cpp"}]

  fuzzysort.highlight(fuzzysort.single('fs', 'Fuzzy Search'), '<b>', '</b>')
  // <b>F</b>uzzy <b>S</b>earch
*/

// UMD (Universal Module Definition) for fuzzysort
;(function(root, UMD) {
  if(typeof define === 'function' && define.amd) define([], UMD)
  else if(typeof module === 'object' && module.exports) module.exports = UMD()
  else root.fuzzysort = UMD()
})(this, function UMD() { function fuzzysortNew(instanceOptions) {

  var fuzzysort = {

    single: function(search, target, options) {
      if(!search) return null
      if(!isObj(search)) search = fuzzysort.getPreparedSearch(search)

      if(!target) return null
      if(!isObj(target)) target = fuzzysort.getPrepared(target)

      var allowTypo = options && options.allowTypo!==undefined ? options.allowTypo
        : instanceOptions && instanceOptions.allowTypo!==undefined ? instanceOptions.allowTypo
        : true
      var algorithm = allowTypo ? fuzzysort.algorithm : fuzzysort.algorithmNoTypo
      return algorithm(search, target, search[0])
      // var threshold = options && options.threshold || instanceOptions && instanceOptions.threshold || -9007199254740991
      // var result = algorithm(search, target, search[0])
      // if(result === null) return null
      // if(result.score < threshold) return null
      // return result
    },

    go: function(search, targets, options) {
      if(!search) return noResults
      search = fuzzysort.prepareSearch(search)
      var searchLowerCode = search[0]

      var threshold = options && options.threshold || instanceOptions && instanceOptions.threshold || -9007199254740991
      var limit = options && options.limit || instanceOptions && instanceOptions.limit || 9007199254740991
      var allowTypo = options && options.allowTypo!==undefined ? options.allowTypo
        : instanceOptions && instanceOptions.allowTypo!==undefined ? instanceOptions.allowTypo
        : true
      var algorithm = allowTypo ? fuzzysort.algorithm : fuzzysort.algorithmNoTypo
      var resultsLen = 0; var limitedCount = 0
      var targetsLen = targets.length

      // This code is copy/pasted 3 times for performance reasons [options.keys, options.key, no keys]

      // options.keys
      if(options && options.keys) {
        var scoreFn = options.scoreFn || defaultScoreFn
        var keys = options.keys
        var keysLen = keys.length
        for(var i = targetsLen - 1; i >= 0; --i) { var obj = targets[i]
          var objResults = new Array(keysLen)
          for (var keyI = keysLen - 1; keyI >= 0; --keyI) {
            var key = keys[keyI]
            var target = getValue(obj, key)
            if(!target) { objResults[keyI] = null; continue }
            if(!isObj(target)) target = fuzzysort.getPrepared(target)

            objResults[keyI] = algorithm(search, target, searchLowerCode)
          }
          objResults.obj = obj // before scoreFn so scoreFn can use it
          var score = scoreFn(objResults)
          if(score === null) continue
          if(score < threshold) continue
          objResults.score = score
          if(resultsLen < limit) { q.add(objResults); ++resultsLen }
          else {
            ++limitedCount
            if(score > q.peek().score) q.replaceTop(objResults)
          }
        }

      // options.key
      } else if(options && options.key) {
        var key = options.key
        for(var i = targetsLen - 1; i >= 0; --i) { var obj = targets[i]
          var target = getValue(obj, key)
          if(!target) continue
          if(!isObj(target)) target = fuzzysort.getPrepared(target)

          var result = algorithm(search, target, searchLowerCode)
          if(result === null) continue
          if(result.score < threshold) continue

          // have to clone result so duplicate targets from different obj can each reference the correct obj
          result = {target:result.target, _targetLowerCodes:null, _nextBeginningIndexes:null, score:result.score, indexes:result.indexes, obj:obj} // hidden

          if(resultsLen < limit) { q.add(result); ++resultsLen }
          else {
            ++limitedCount
            if(result.score > q.peek().score) q.replaceTop(result)
          }
        }

      // no keys
      } else {
        for(var i = targetsLen - 1; i >= 0; --i) { var target = targets[i]
          if(!target) continue
          if(!isObj(target)) target = fuzzysort.getPrepared(target)

          var result = algorithm(search, target, searchLowerCode)
          if(result === null) continue
          if(result.score < threshold) continue
          if(resultsLen < limit) { q.add(result); ++resultsLen }
          else {
            ++limitedCount
            if(result.score > q.peek().score) q.replaceTop(result)
          }
        }
      }

      if(resultsLen === 0) return noResults
      var results = new Array(resultsLen)
      for(var i = resultsLen - 1; i >= 0; --i) results[i] = q.poll()
      results.total = resultsLen + limitedCount
      return results
    },

    goAsync: function(search, targets, options) {
      var canceled = false
      var p = new Promise(function(resolve, reject) {
        if(!search) return resolve(noResults)
        search = fuzzysort.prepareSearch(search)
        var searchLowerCode = search[0]

        var q = fastpriorityqueue()
        var iCurrent = targets.length - 1
        var threshold = options && options.threshold || instanceOptions && instanceOptions.threshold || -9007199254740991
        var limit = options && options.limit || instanceOptions && instanceOptions.limit || 9007199254740991
        var allowTypo = options && options.allowTypo!==undefined ? options.allowTypo
          : instanceOptions && instanceOptions.allowTypo!==undefined ? instanceOptions.allowTypo
          : true
        var algorithm = allowTypo ? fuzzysort.algorithm : fuzzysort.algorithmNoTypo
        var resultsLen = 0; var limitedCount = 0
        function step() {
          if(canceled) return reject('canceled')

          var startMs = Date.now()

          // This code is copy/pasted 3 times for performance reasons [options.keys, options.key, no keys]

          // options.keys
          if(options && options.keys) {
            var scoreFn = options.scoreFn || defaultScoreFn
            var keys = options.keys
            var keysLen = keys.length
            for(; iCurrent >= 0; --iCurrent) { var obj = targets[iCurrent]
              var objResults = new Array(keysLen)
              for (var keyI = keysLen - 1; keyI >= 0; --keyI) {
                var key = keys[keyI]
                var target = getValue(obj, key)
                if(!target) { objResults[keyI] = null; continue }
                if(!isObj(target)) target = fuzzysort.getPrepared(target)

                objResults[keyI] = algorithm(search, target, searchLowerCode)
              }
              objResults.obj = obj // before scoreFn so scoreFn can use it
              var score = scoreFn(objResults)
              if(score === null) continue
              if(score < threshold) continue
              objResults.score = score
              if(resultsLen < limit) { q.add(objResults); ++resultsLen }
              else {
                ++limitedCount
                if(score > q.peek().score) q.replaceTop(objResults)
              }

              if(iCurrent%1000/*itemsPerCheck*/ === 0) {
                if(Date.now() - startMs >= 10/*asyncInterval*/) {
                  isNode?setImmediate(step):setTimeout(step)
                  return
                }
              }
            }

          // options.key
          } else if(options && options.key) {
            var key = options.key
            for(; iCurrent >= 0; --iCurrent) { var obj = targets[iCurrent]
              var target = getValue(obj, key)
              if(!target) continue
              if(!isObj(target)) target = fuzzysort.getPrepared(target)

              var result = algorithm(search, target, searchLowerCode)
              if(result === null) continue
              if(result.score < threshold) continue

              // have to clone result so duplicate targets from different obj can each reference the correct obj
              result = {target:result.target, _targetLowerCodes:null, _nextBeginningIndexes:null, score:result.score, indexes:result.indexes, obj:obj} // hidden

              if(resultsLen < limit) { q.add(result); ++resultsLen }
              else {
                ++limitedCount
                if(result.score > q.peek().score) q.replaceTop(result)
              }

              if(iCurrent%1000/*itemsPerCheck*/ === 0) {
                if(Date.now() - startMs >= 10/*asyncInterval*/) {
                  isNode?setImmediate(step):setTimeout(step)
                  return
                }
              }
            }

          // no keys
          } else {
            for(; iCurrent >= 0; --iCurrent) { var target = targets[iCurrent]
              if(!target) continue
              if(!isObj(target)) target = fuzzysort.getPrepared(target)

              var result = algorithm(search, target, searchLowerCode)
              if(result === null) continue
              if(result.score < threshold) continue
              if(resultsLen < limit) { q.add(result); ++resultsLen }
              else {
                ++limitedCount
                if(result.score > q.peek().score) q.replaceTop(result)
              }

              if(iCurrent%1000/*itemsPerCheck*/ === 0) {
                if(Date.now() - startMs >= 10/*asyncInterval*/) {
                  isNode?setImmediate(step):setTimeout(step)
                  return
                }
              }
            }
          }

          if(resultsLen === 0) return resolve(noResults)
          var results = new Array(resultsLen)
          for(var i = resultsLen - 1; i >= 0; --i) results[i] = q.poll()
          results.total = resultsLen + limitedCount
          resolve(results)
        }

        isNode?setImmediate(step):step()
      })
      p.cancel = function() { canceled = true }
      return p
    },

    highlight: function(result, hOpen, hClose) {
      if(result === null) return null
      if(hOpen === undefined) hOpen = '<b>'
      if(hClose === undefined) hClose = '</b>'
      var highlighted = ''
      var matchesIndex = 0
      var opened = false
      var target = result.target
      var targetLen = target.length
      var matchesBest = result.indexes
      for(var i = 0; i < targetLen; ++i) { var char = target[i]
        if(matchesBest[matchesIndex] === i) {
          ++matchesIndex
          if(!opened) { opened = true
            highlighted += hOpen
          }

          if(matchesIndex === matchesBest.length) {
            highlighted += char + hClose + target.substr(i+1)
            break
          }
        } else {
          if(opened) { opened = false
            highlighted += hClose
          }
        }
        highlighted += char
      }

      return highlighted
    },

    prepare: function(target) {
      if(!target) return
      return {target:target, _targetLowerCodes:fuzzysort.prepareLowerCodes(target), _nextBeginningIndexes:null, score:null, indexes:null, obj:null} // hidden
    },
    prepareSlow: function(target) {
      if(!target) return
      return {target:target, _targetLowerCodes:fuzzysort.prepareLowerCodes(target), _nextBeginningIndexes:fuzzysort.prepareNextBeginningIndexes(target), score:null, indexes:null, obj:null} // hidden
    },
    prepareSearch: function(search) {
      if(!search) return
      return fuzzysort.prepareLowerCodes(search)
    },



    // Below this point is only internal code
    // Below this point is only internal code
    // Below this point is only internal code
    // Below this point is only internal code



    getPrepared: function(target) {
      if(target.length > 999) return fuzzysort.prepare(target) // don't cache huge targets
      var targetPrepared = preparedCache.get(target)
      if(targetPrepared !== undefined) return targetPrepared
      targetPrepared = fuzzysort.prepare(target)
      preparedCache.set(target, targetPrepared)
      return targetPrepared
    },
    getPreparedSearch: function(search) {
      if(search.length > 999) return fuzzysort.prepareSearch(search) // don't cache huge searches
      var searchPrepared = preparedSearchCache.get(search)
      if(searchPrepared !== undefined) return searchPrepared
      searchPrepared = fuzzysort.prepareSearch(search)
      preparedSearchCache.set(search, searchPrepared)
      return searchPrepared
    },

    algorithm: function(searchLowerCodes, prepared, searchLowerCode) {
      var targetLowerCodes = prepared._targetLowerCodes
      var searchLen = searchLowerCodes.length
      var targetLen = targetLowerCodes.length
      var searchI = 0 // where we at
      var targetI = 0 // where you at
      var typoSimpleI = 0
      var matchesSimpleLen = 0

      // very basic fuzzy match; to remove non-matching targets ASAP!
      // walk through target. find sequential matches.
      // if all chars aren't found then exit
      for(;;) {
        var isMatch = searchLowerCode === targetLowerCodes[targetI]
        if(isMatch) {
          matchesSimple[matchesSimpleLen++] = targetI
          ++searchI; if(searchI === searchLen) break
          searchLowerCode = searchLowerCodes[typoSimpleI===0?searchI : (typoSimpleI===searchI?searchI+1 : (typoSimpleI===searchI-1?searchI-1 : searchI))]
        }

        ++targetI; if(targetI >= targetLen) { // Failed to find searchI
          // Check for typo or exit
          // we go as far as possible before trying to transpose
          // then we transpose backwards until we reach the beginning
          for(;;) {
            if(searchI <= 1) return null // not allowed to transpose first char
            if(typoSimpleI === 0) { // we haven't tried to transpose yet
              --searchI
              var searchLowerCodeNew = searchLowerCodes[searchI]
              if(searchLowerCode === searchLowerCodeNew) continue // doesn't make sense to transpose a repeat char
              typoSimpleI = searchI
            } else {
              if(typoSimpleI === 1) return null // reached the end of the line for transposing
              --typoSimpleI
              searchI = typoSimpleI
              searchLowerCode = searchLowerCodes[searchI + 1]
              var searchLowerCodeNew = searchLowerCodes[searchI]
              if(searchLowerCode === searchLowerCodeNew) continue // doesn't make sense to transpose a repeat char
            }
            matchesSimpleLen = searchI
            targetI = matchesSimple[matchesSimpleLen - 1] + 1
            break
          }
        }
      }

      var searchI = 0
      var typoStrictI = 0
      var successStrict = false
      var matchesStrictLen = 0

      var nextBeginningIndexes = prepared._nextBeginningIndexes
      if(nextBeginningIndexes === null) nextBeginningIndexes = prepared._nextBeginningIndexes = fuzzysort.prepareNextBeginningIndexes(prepared.target)
      var firstPossibleI = targetI = matchesSimple[0]===0 ? 0 : nextBeginningIndexes[matchesSimple[0]-1]

      // Our target string successfully matched all characters in sequence!
      // Let's try a more advanced and strict test to improve the score
      // only count it as a match if it's consecutive or a beginning character!
      if(targetI !== targetLen) for(;;) {
        if(targetI >= targetLen) {
          // We failed to find a good spot for this search char, go back to the previous search char and force it forward
          if(searchI <= 0) { // We failed to push chars forward for a better match
            // transpose, starting from the beginning
            ++typoStrictI; if(typoStrictI > searchLen-2) break
            if(searchLowerCodes[typoStrictI] === searchLowerCodes[typoStrictI+1]) continue // doesn't make sense to transpose a repeat char
            targetI = firstPossibleI
            continue
          }

          --searchI
          var lastMatch = matchesStrict[--matchesStrictLen]
          targetI = nextBeginningIndexes[lastMatch]

        } else {
          var isMatch = searchLowerCodes[typoStrictI===0?searchI : (typoStrictI===searchI?searchI+1 : (typoStrictI===searchI-1?searchI-1 : searchI))] === targetLowerCodes[targetI]
          if(isMatch) {
            matchesStrict[matchesStrictLen++] = targetI
            ++searchI; if(searchI === searchLen) { successStrict = true; break }
            ++targetI
          } else {
            targetI = nextBeginningIndexes[targetI]
          }
        }
      }

      { // tally up the score & keep track of matches for highlighting later
        if(successStrict) { var matchesBest = matchesStrict; var matchesBestLen = matchesStrictLen }
        else { var matchesBest = matchesSimple; var matchesBestLen = matchesSimpleLen }
        var score = 0
        var lastTargetI = -1
        for(var i = 0; i < searchLen; ++i) { var targetI = matchesBest[i]
          // score only goes down if they're not consecutive
          if(lastTargetI !== targetI - 1) score -= targetI
          lastTargetI = targetI
        }
        if(!successStrict) {
          score *= 1000
          if(typoSimpleI !== 0) score += -20/*typoPenalty*/
        } else {
          if(typoStrictI !== 0) score += -20/*typoPenalty*/
        }
        score -= targetLen - searchLen
        prepared.score = score
        prepared.indexes = new Array(matchesBestLen); for(var i = matchesBestLen - 1; i >= 0; --i) prepared.indexes[i] = matchesBest[i]

        return prepared
      }
    },

    algorithmNoTypo: function(searchLowerCodes, prepared, searchLowerCode) {
      var targetLowerCodes = prepared._targetLowerCodes
      var searchLen = searchLowerCodes.length
      var targetLen = targetLowerCodes.length
      var searchI = 0 // where we at
      var targetI = 0 // where you at
      var matchesSimpleLen = 0

      // very basic fuzzy match; to remove non-matching targets ASAP!
      // walk through target. find sequential matches.
      // if all chars aren't found then exit
      for(;;) {
        var isMatch = searchLowerCode === targetLowerCodes[targetI]
        if(isMatch) {
          matchesSimple[matchesSimpleLen++] = targetI
          ++searchI; if(searchI === searchLen) break
          searchLowerCode = searchLowerCodes[searchI]
        }
        ++targetI; if(targetI >= targetLen) return null // Failed to find searchI
      }

      var searchI = 0
      var successStrict = false
      var matchesStrictLen = 0

      var nextBeginningIndexes = prepared._nextBeginningIndexes
      if(nextBeginningIndexes === null) nextBeginningIndexes = prepared._nextBeginningIndexes = fuzzysort.prepareNextBeginningIndexes(prepared.target)
      var firstPossibleI = targetI = matchesSimple[0]===0 ? 0 : nextBeginningIndexes[matchesSimple[0]-1]

      // Our target string successfully matched all characters in sequence!
      // Let's try a more advanced and strict test to improve the score
      // only count it as a match if it's consecutive or a beginning character!
      if(targetI !== targetLen) for(;;) {
        if(targetI >= targetLen) {
          // We failed to find a good spot for this search char, go back to the previous search char and force it forward
          if(searchI <= 0) break // We failed to push chars forward for a better match

          --searchI
          var lastMatch = matchesStrict[--matchesStrictLen]
          targetI = nextBeginningIndexes[lastMatch]

        } else {
          var isMatch = searchLowerCodes[searchI] === targetLowerCodes[targetI]
          if(isMatch) {
            matchesStrict[matchesStrictLen++] = targetI
            ++searchI; if(searchI === searchLen) { successStrict = true; break }
            ++targetI
          } else {
            targetI = nextBeginningIndexes[targetI]
          }
        }
      }

      { // tally up the score & keep track of matches for highlighting later
        if(successStrict) { var matchesBest = matchesStrict; var matchesBestLen = matchesStrictLen }
        else { var matchesBest = matchesSimple; var matchesBestLen = matchesSimpleLen }
        var score = 0
        var lastTargetI = -1
        for(var i = 0; i < searchLen; ++i) { var targetI = matchesBest[i]
          // score only goes down if they're not consecutive
          if(lastTargetI !== targetI - 1) score -= targetI
          lastTargetI = targetI
        }
        if(!successStrict) score *= 1000
        score -= targetLen - searchLen
        prepared.score = score
        prepared.indexes = new Array(matchesBestLen); for(var i = matchesBestLen - 1; i >= 0; --i) prepared.indexes[i] = matchesBest[i]

        return prepared
      }
    },

    prepareLowerCodes: function(str) {
      var strLen = str.length
      var lowerCodes = [] // new Array(strLen)    sparse array is too slow
      var lower = str.toLowerCase()
      for(var i = 0; i < strLen; ++i) lowerCodes[i] = lower.charCodeAt(i)
      return lowerCodes
    },
    prepareBeginningIndexes: function(target) {
      var targetLen = target.length
      var beginningIndexes = []; var beginningIndexesLen = 0
      var wasUpper = false
      var wasAlphanum = false
      for(var i = 0; i < targetLen; ++i) {
        var targetCode = target.charCodeAt(i)
        var isUpper = targetCode>=65&&targetCode<=90
        var isAlphanum = isUpper || targetCode>=97&&targetCode<=122 || targetCode>=48&&targetCode<=57
        var isBeginning = isUpper && !wasUpper || !wasAlphanum || !isAlphanum
        wasUpper = isUpper
        wasAlphanum = isAlphanum
        if(isBeginning) beginningIndexes[beginningIndexesLen++] = i
      }
      return beginningIndexes
    },
    prepareNextBeginningIndexes: function(target) {
      var targetLen = target.length
      var beginningIndexes = fuzzysort.prepareBeginningIndexes(target)
      var nextBeginningIndexes = [] // new Array(targetLen)     sparse array is too slow
      var lastIsBeginning = beginningIndexes[0]
      var lastIsBeginningI = 0
      for(var i = 0; i < targetLen; ++i) {
        if(lastIsBeginning > i) {
          nextBeginningIndexes[i] = lastIsBeginning
        } else {
          lastIsBeginning = beginningIndexes[++lastIsBeginningI]
          nextBeginningIndexes[i] = lastIsBeginning===undefined ? targetLen : lastIsBeginning
        }
      }
      return nextBeginningIndexes
    },

    cleanup: cleanup,
    new: fuzzysortNew,
  }
  return fuzzysort
} // fuzzysortNew

// This stuff is outside fuzzysortNew, because it's shared with instances of fuzzysort.new()
var isNode = typeof require !== 'undefined' && typeof window === 'undefined'
// var MAX_INT = Number.MAX_SAFE_INTEGER
// var MIN_INT = Number.MIN_VALUE
var preparedCache = new Map()
var preparedSearchCache = new Map()
var noResults = []; noResults.total = 0
var matchesSimple = []; var matchesStrict = []
function cleanup() { preparedCache.clear(); preparedSearchCache.clear(); matchesSimple = []; matchesStrict = [] }
function defaultScoreFn(a) {
  var max = -9007199254740991
  for (var i = a.length - 1; i >= 0; --i) {
    var result = a[i]; if(result === null) continue
    var score = result.score
    if(score > max) max = score
  }
  if(max === -9007199254740991) return null
  return max
}

// prop = 'key'              2.5ms optimized for this case, seems to be about as fast as direct obj[prop]
// prop = 'key1.key2'        10ms
// prop = ['key1', 'key2']   27ms
function getValue(obj, prop) {
  var tmp = obj[prop]; if(tmp !== undefined) return tmp
  var segs = prop
  if(!Array.isArray(prop)) segs = prop.split('.')
  var len = segs.length
  var i = -1
  while (obj && (++i < len)) obj = obj[segs[i]]
  return obj
}

function isObj(x) { return typeof x === 'object' } // faster as a function

// Hacked version of https://github.com/lemire/FastPriorityQueue.js
var fastpriorityqueue=function(){var r=[],o=0,e={};function n(){for(var e=0,n=r[e],c=1;c<o;){var f=c+1;e=c,f<o&&r[f].score<r[c].score&&(e=f),r[e-1>>1]=r[e],c=1+(e<<1)}for(var a=e-1>>1;e>0&&n.score<r[a].score;a=(e=a)-1>>1)r[e]=r[a];r[e]=n}return e.add=function(e){var n=o;r[o++]=e;for(var c=n-1>>1;n>0&&e.score<r[c].score;c=(n=c)-1>>1)r[n]=r[c];r[n]=e},e.poll=function(){if(0!==o){var e=r[0];return r[0]=r[--o],n(),e}},e.peek=function(e){if(0!==o)return r[0]},e.replaceTop=function(o){r[0]=o,n()},e};
var q = fastpriorityqueue() // reuse this, except for async, it needs to make its own

return fuzzysortNew()
}) // UMD

// TODO: (performance) wasm version!?

// TODO: (performance) layout memory in an optimal way to go fast by avoiding cache misses

// TODO: (performance) preparedCache is a memory leak

// TODO: (like sublime) backslash === forwardslash

// TODO: (performance) i have no idea how well optizmied the allowing typos algorithm is

}).call(this,require("timers").setImmediate)
},{"timers":18}],11:[function(require,module,exports){
'use strict';

const instanceOfAny = (object, constructors) => constructors.some(c => object instanceof c);

let idbProxyableTypes;
let cursorAdvanceMethods;
// This is a function to prevent it throwing up in node environments.
function getIdbProxyableTypes() {
    return idbProxyableTypes ||
        (idbProxyableTypes = [IDBDatabase, IDBObjectStore, IDBIndex, IDBCursor, IDBTransaction]);
}
// This is a function to prevent it throwing up in node environments.
function getCursorAdvanceMethods() {
    return cursorAdvanceMethods || (cursorAdvanceMethods = [
        IDBCursor.prototype.advance,
        IDBCursor.prototype.continue,
        IDBCursor.prototype.continuePrimaryKey,
    ]);
}
const cursorRequestMap = new WeakMap();
const transactionDoneMap = new WeakMap();
const transactionStoreNamesMap = new WeakMap();
const transformCache = new WeakMap();
const reverseTransformCache = new WeakMap();
function promisifyRequest(request) {
    const promise = new Promise((resolve, reject) => {
        const unlisten = () => {
            request.removeEventListener('success', success);
            request.removeEventListener('error', error);
        };
        const success = () => {
            resolve(wrap(request.result));
            unlisten();
        };
        const error = () => {
            reject(request.error);
            unlisten();
        };
        request.addEventListener('success', success);
        request.addEventListener('error', error);
    });
    promise.then((value) => {
        // Since cursoring reuses the IDBRequest (*sigh*), we cache it for later retrieval
        // (see wrapFunction).
        if (value instanceof IDBCursor) {
            cursorRequestMap.set(value, request);
        }
    });
    // This mapping exists in reverseTransformCache but doesn't doesn't exist in transformCache. This
    // is because we create many promises from a single IDBRequest.
    reverseTransformCache.set(promise, request);
    return promise;
}
function cacheDonePromiseForTransaction(tx) {
    // Early bail if we've already created a done promise for this transaction.
    if (transactionDoneMap.has(tx))
        return;
    const done = new Promise((resolve, reject) => {
        const unlisten = () => {
            tx.removeEventListener('complete', complete);
            tx.removeEventListener('error', error);
            tx.removeEventListener('abort', error);
        };
        const complete = () => {
            resolve();
            unlisten();
        };
        const error = () => {
            reject(tx.error);
            unlisten();
        };
        tx.addEventListener('complete', complete);
        tx.addEventListener('error', error);
        tx.addEventListener('abort', error);
    });
    // Cache it for later retrieval.
    transactionDoneMap.set(tx, done);
}
let idbProxyTraps = {
    get(target, prop, receiver) {
        if (target instanceof IDBTransaction) {
            // Special handling for transaction.done.
            if (prop === 'done')
                return transactionDoneMap.get(target);
            // Polyfill for objectStoreNames because of Edge.
            if (prop === 'objectStoreNames') {
                return target.objectStoreNames || transactionStoreNamesMap.get(target);
            }
            // Make tx.store return the only store in the transaction, or undefined if there are many.
            if (prop === 'store') {
                return receiver.objectStoreNames[1] ?
                    undefined : receiver.objectStore(receiver.objectStoreNames[0]);
            }
        }
        // Else transform whatever we get back.
        return wrap(target[prop]);
    },
    has(target, prop) {
        if (target instanceof IDBTransaction && (prop === 'done' || prop === 'store'))
            return true;
        return prop in target;
    },
};
function addTraps(callback) {
    idbProxyTraps = callback(idbProxyTraps);
}
function wrapFunction(func) {
    // Due to expected object equality (which is enforced by the caching in `wrap`), we
    // only create one new func per func.
    // Edge doesn't support objectStoreNames (booo), so we polyfill it here.
    if (func === IDBDatabase.prototype.transaction &&
        !('objectStoreNames' in IDBTransaction.prototype)) {
        return function (storeNames, ...args) {
            const tx = func.call(unwrap(this), storeNames, ...args);
            transactionStoreNamesMap.set(tx, storeNames.sort ? storeNames.sort() : [storeNames]);
            return wrap(tx);
        };
    }
    // Cursor methods are special, as the behaviour is a little more different to standard IDB. In
    // IDB, you advance the cursor and wait for a new 'success' on the IDBRequest that gave you the
    // cursor. It's kinda like a promise that can resolve with many values. That doesn't make sense
    // with real promises, so each advance methods returns a new promise for the cursor object, or
    // undefined if the end of the cursor has been reached.
    if (getCursorAdvanceMethods().includes(func)) {
        return function (...args) {
            // Calling the original function with the proxy as 'this' causes ILLEGAL INVOCATION, so we use
            // the original object.
            func.apply(unwrap(this), args);
            return wrap(cursorRequestMap.get(this));
        };
    }
    return function (...args) {
        // Calling the original function with the proxy as 'this' causes ILLEGAL INVOCATION, so we use
        // the original object.
        return wrap(func.apply(unwrap(this), args));
    };
}
function transformCachableValue(value) {
    if (typeof value === 'function')
        return wrapFunction(value);
    // This doesn't return, it just creates a 'done' promise for the transaction,
    // which is later returned for transaction.done (see idbObjectHandler).
    if (value instanceof IDBTransaction)
        cacheDonePromiseForTransaction(value);
    if (instanceOfAny(value, getIdbProxyableTypes()))
        return new Proxy(value, idbProxyTraps);
    // Return the same value back if we're not going to transform it.
    return value;
}
function wrap(value) {
    // We sometimes generate multiple promises from a single IDBRequest (eg when cursoring), because
    // IDB is weird and a single IDBRequest can yield many responses, so these can't be cached.
    if (value instanceof IDBRequest)
        return promisifyRequest(value);
    // If we've already transformed this value before, reuse the transformed value.
    // This is faster, but it also provides object equality.
    if (transformCache.has(value))
        return transformCache.get(value);
    const newValue = transformCachableValue(value);
    // Not all types are transformed.
    // These may be primitive types, so they can't be WeakMap keys.
    if (newValue !== value) {
        transformCache.set(value, newValue);
        reverseTransformCache.set(newValue, value);
    }
    return newValue;
}
const unwrap = (value) => reverseTransformCache.get(value);

exports.wrap = wrap;
exports.addTraps = addTraps;
exports.instanceOfAny = instanceOfAny;
exports.reverseTransformCache = reverseTransformCache;
exports.unwrap = unwrap;

},{}],12:[function(require,module,exports){
'use strict';

Object.defineProperty(exports, '__esModule', { value: true });

var __chunk_1 = require('./chunk.js');

/**
 * Open a database.
 *
 * @param name Name of the database.
 * @param version Schema version.
 * @param callbacks Additional callbacks.
 */
function openDB(name, version, { blocked, upgrade, blocking } = {}) {
    const request = indexedDB.open(name, version);
    const openPromise = __chunk_1.wrap(request);
    if (upgrade) {
        request.addEventListener('upgradeneeded', (event) => {
            upgrade(__chunk_1.wrap(request.result), event.oldVersion, event.newVersion, __chunk_1.wrap(request.transaction));
        });
    }
    if (blocked)
        request.addEventListener('blocked', () => blocked());
    if (blocking)
        openPromise.then(db => db.addEventListener('versionchange', blocking));
    return openPromise;
}
/**
 * Delete a database.
 *
 * @param name Name of the database.
 */
function deleteDB(name, { blocked } = {}) {
    const request = indexedDB.deleteDatabase(name);
    if (blocked)
        request.addEventListener('blocked', () => blocked());
    return __chunk_1.wrap(request).then(() => undefined);
}

const readMethods = ['get', 'getKey', 'getAll', 'getAllKeys', 'count'];
const writeMethods = ['put', 'add', 'delete', 'clear'];
const cachedMethods = new Map();
function getMethod(target, prop) {
    if (!(target instanceof IDBDatabase &&
        !(prop in target) &&
        typeof prop === 'string'))
        return;
    if (cachedMethods.get(prop))
        return cachedMethods.get(prop);
    const targetFuncName = prop.replace(/FromIndex$/, '');
    const useIndex = prop !== targetFuncName;
    const isWrite = writeMethods.includes(targetFuncName);
    if (
    // Bail if the target doesn't exist on the target. Eg, getAll isn't in Edge.
    !(targetFuncName in (useIndex ? IDBIndex : IDBObjectStore).prototype) ||
        !(isWrite || readMethods.includes(targetFuncName)))
        return;
    const method = async function (storeName, ...args) {
        const tx = this.transaction(storeName, isWrite ? 'readwrite' : 'readonly');
        let target = tx.store;
        if (useIndex)
            target = target.index(args.shift());
        const returnVal = target[targetFuncName](...args);
        if (isWrite)
            await tx.done;
        return returnVal;
    };
    cachedMethods.set(prop, method);
    return method;
}
__chunk_1.addTraps(oldTraps => ({
    get: (target, prop, receiver) => getMethod(target, prop) || oldTraps.get(target, prop, receiver),
    has: (target, prop) => !!getMethod(target, prop) || oldTraps.has(target, prop),
}));

exports.unwrap = __chunk_1.unwrap;
exports.wrap = __chunk_1.wrap;
exports.openDB = openDB;
exports.deleteDB = deleteDB;

},{"./chunk.js":11}],13:[function(require,module,exports){
exports.read = function (buffer, offset, isLE, mLen, nBytes) {
  var e, m
  var eLen = (nBytes * 8) - mLen - 1
  var eMax = (1 << eLen) - 1
  var eBias = eMax >> 1
  var nBits = -7
  var i = isLE ? (nBytes - 1) : 0
  var d = isLE ? -1 : 1
  var s = buffer[offset + i]

  i += d

  e = s & ((1 << (-nBits)) - 1)
  s >>= (-nBits)
  nBits += eLen
  for (; nBits > 0; e = (e * 256) + buffer[offset + i], i += d, nBits -= 8) {}

  m = e & ((1 << (-nBits)) - 1)
  e >>= (-nBits)
  nBits += mLen
  for (; nBits > 0; m = (m * 256) + buffer[offset + i], i += d, nBits -= 8) {}

  if (e === 0) {
    e = 1 - eBias
  } else if (e === eMax) {
    return m ? NaN : ((s ? -1 : 1) * Infinity)
  } else {
    m = m + Math.pow(2, mLen)
    e = e - eBias
  }
  return (s ? -1 : 1) * m * Math.pow(2, e - mLen)
}

exports.write = function (buffer, value, offset, isLE, mLen, nBytes) {
  var e, m, c
  var eLen = (nBytes * 8) - mLen - 1
  var eMax = (1 << eLen) - 1
  var eBias = eMax >> 1
  var rt = (mLen === 23 ? Math.pow(2, -24) - Math.pow(2, -77) : 0)
  var i = isLE ? 0 : (nBytes - 1)
  var d = isLE ? 1 : -1
  var s = value < 0 || (value === 0 && 1 / value < 0) ? 1 : 0

  value = Math.abs(value)

  if (isNaN(value) || value === Infinity) {
    m = isNaN(value) ? 1 : 0
    e = eMax
  } else {
    e = Math.floor(Math.log(value) / Math.LN2)
    if (value * (c = Math.pow(2, -e)) < 1) {
      e--
      c *= 2
    }
    if (e + eBias >= 1) {
      value += rt / c
    } else {
      value += rt * Math.pow(2, 1 - eBias)
    }
    if (value * c >= 2) {
      e++
      c /= 2
    }

    if (e + eBias >= eMax) {
      m = 0
      e = eMax
    } else if (e + eBias >= 1) {
      m = ((value * c) - 1) * Math.pow(2, mLen)
      e = e + eBias
    } else {
      m = value * Math.pow(2, eBias - 1) * Math.pow(2, mLen)
      e = 0
    }
  }

  for (; mLen >= 8; buffer[offset + i] = m & 0xff, i += d, m /= 256, mLen -= 8) {}

  e = (e << mLen) | m
  eLen += mLen
  for (; eLen > 0; buffer[offset + i] = e & 0xff, i += d, e /= 256, eLen -= 8) {}

  buffer[offset + i - d] |= s * 128
}

},{}],14:[function(require,module,exports){
(function (process){
// A simple implementation of make-array
function makeArray (subject) {
  return Array.isArray(subject)
    ? subject
    : [subject]
}

const REGEX_TEST_BLANK_LINE = /^\s+$/
const REGEX_REPLACE_LEADING_EXCAPED_EXCLAMATION = /^\\!/
const REGEX_REPLACE_LEADING_EXCAPED_HASH = /^\\#/
const REGEX_SPLITALL_CRLF = /\r?\n/g
// /foo,
// ./foo,
// ../foo,
// .
// ..
const REGEX_TEST_INVALID_PATH = /^\.*\/|^\.+$/

const SLASH = '/'
const KEY_IGNORE = typeof Symbol !== 'undefined'
  ? Symbol.for('node-ignore')
  /* istanbul ignore next */
  : 'node-ignore'

const define = (object, key, value) =>
  Object.defineProperty(object, key, {value})

const REGEX_REGEXP_RANGE = /([0-z])-([0-z])/g

// Sanitize the range of a regular expression
// The cases are complicated, see test cases for details
const sanitizeRange = range => range.replace(
  REGEX_REGEXP_RANGE,
  (match, from, to) => from.charCodeAt(0) <= to.charCodeAt(0)
    ? match
    // Invalid range (out of order) which is ok for gitignore rules but
    //   fatal for JavaScript regular expression, so eliminate it.
    : ''
)

// > If the pattern ends with a slash,
// > it is removed for the purpose of the following description,
// > but it would only find a match with a directory.
// > In other words, foo/ will match a directory foo and paths underneath it,
// > but will not match a regular file or a symbolic link foo
// >  (this is consistent with the way how pathspec works in general in Git).
// '`foo/`' will not match regular file '`foo`' or symbolic link '`foo`'
// -> ignore-rules will not deal with it, because it costs extra `fs.stat` call
//      you could use option `mark: true` with `glob`

// '`foo/`' should not continue with the '`..`'
const REPLACERS = [

  // > Trailing spaces are ignored unless they are quoted with backslash ("\")
  [
    // (a\ ) -> (a )
    // (a  ) -> (a)
    // (a \ ) -> (a  )
    /\\?\s+$/,
    match => match.indexOf('\\') === 0
      ? ' '
      : ''
  ],

  // replace (\ ) with ' '
  [
    /\\\s/g,
    () => ' '
  ],

  // Escape metacharacters
  // which is written down by users but means special for regular expressions.

  // > There are 12 characters with special meanings:
  // > - the backslash \,
  // > - the caret ^,
  // > - the dollar sign $,
  // > - the period or dot .,
  // > - the vertical bar or pipe symbol |,
  // > - the question mark ?,
  // > - the asterisk or star *,
  // > - the plus sign +,
  // > - the opening parenthesis (,
  // > - the closing parenthesis ),
  // > - and the opening square bracket [,
  // > - the opening curly brace {,
  // > These special characters are often called "metacharacters".
  [
    /[\\^$.|*+(){]/g,
    match => `\\${match}`
  ],

  [
    // > [abc] matches any character inside the brackets
    // >    (in this case a, b, or c);
    /\[([^\]/]*)($|\])/g,
    (match, p1, p2) => p2 === ']'
      ? `[${sanitizeRange(p1)}]`
      : `\\${match}`
  ],

  [
    // > a question mark (?) matches a single character
    /(?!\\)\?/g,
    () => '[^/]'
  ],

  // leading slash
  [

    // > A leading slash matches the beginning of the pathname.
    // > For example, "/*.c" matches "cat-file.c" but not "mozilla-sha1/sha1.c".
    // A leading slash matches the beginning of the pathname
    /^\//,
    () => '^'
  ],

  // replace special metacharacter slash after the leading slash
  [
    /\//g,
    () => '\\/'
  ],

  [
    // > A leading "**" followed by a slash means match in all directories.
    // > For example, "**/foo" matches file or directory "foo" anywhere,
    // > the same as pattern "foo".
    // > "**/foo/bar" matches file or directory "bar" anywhere that is directly
    // >   under directory "foo".
    // Notice that the '*'s have been replaced as '\\*'
    /^\^*\\\*\\\*\\\//,

    // '**/foo' <-> 'foo'
    () => '^(?:.*\\/)?'
  ],

  // ending
  [
    // 'js' will not match 'js.'
    // 'ab' will not match 'abc'
    /(?:[^*])$/,

    // WTF!
    // https://git-scm.com/docs/gitignore
    // changes in [2.22.1](https://git-scm.com/docs/gitignore/2.22.1)
    // which re-fixes #24, #38

    // > If there is a separator at the end of the pattern then the pattern
    // > will only match directories, otherwise the pattern can match both
    // > files and directories.

    // 'js*' will not match 'a.js'
    // 'js/' will not match 'a.js'
    // 'js' will match 'a.js' and 'a.js/'
    match => /\/$/.test(match)
      // foo/ will not match 'foo'
      ? `${match}$`
      // foo matches 'foo' and 'foo/'
      : `${match}(?=$|\\/$)`
  ],

  // starting
  [
    // there will be no leading '/'
    //   (which has been replaced by section "leading slash")
    // If starts with '**', adding a '^' to the regular expression also works
    /^(?=[^^])/,
    function startingReplacer () {
      // If has a slash `/` at the beginning or middle
      return !/\/(?!$)/.test(this)
        // > Prior to 2.22.1
        // > If the pattern does not contain a slash /,
        // >   Git treats it as a shell glob pattern
        // Actually, if there is only a trailing slash,
        //   git also treats it as a shell glob pattern

        // After 2.22.1 (compatible but clearer)
        // > If there is a separator at the beginning or middle (or both)
        // > of the pattern, then the pattern is relative to the directory
        // > level of the particular .gitignore file itself.
        // > Otherwise the pattern may also match at any level below
        // > the .gitignore level.
        ? '(?:^|\\/)'

        // > Otherwise, Git treats the pattern as a shell glob suitable for
        // >   consumption by fnmatch(3)
        : '^'
    }
  ],

  // two globstars
  [
    // Use lookahead assertions so that we could match more than one `'/**'`
    /\\\/\\\*\\\*(?=\\\/|$)/g,

    // Zero, one or several directories
    // should not use '*', or it will be replaced by the next replacer

    // Check if it is not the last `'/**'`
    (_, index, str) => index + 6 < str.length

      // case: /**/
      // > A slash followed by two consecutive asterisks then a slash matches
      // >   zero or more directories.
      // > For example, "a/**/b" matches "a/b", "a/x/b", "a/x/y/b" and so on.
      // '/**/'
      ? '(?:\\/[^\\/]+)*'

      // case: /**
      // > A trailing `"/**"` matches everything inside.

      // #21: everything inside but it should not include the current folder
      : '\\/.+'
  ],

  // intermediate wildcards
  [
    // Never replace escaped '*'
    // ignore rule '\*' will match the path '*'

    // 'abc.*/' -> go
    // 'abc.*'  -> skip this rule
    /(^|[^\\]+)\\\*(?=.+)/g,

    // '*.js' matches '.js'
    // '*.js' doesn't match 'abc'
    (_, p1) => `${p1}[^\\/]*`
  ],

  // trailing wildcard
  [
    /(\^|\\\/)?\\\*$/,
    (_, p1) => {
      const prefix = p1
        // '\^':
        // '/*' does not match ''
        // '/*' does not match everything

        // '\\\/':
        // 'abc/*' does not match 'abc/'
        ? `${p1}[^/]+`

        // 'a*' matches 'a'
        // 'a*' matches 'aa'
        : '[^/]*'

      return `${prefix}(?=$|\\/$)`
    }
  ],

  [
    // unescape
    /\\\\\\/g,
    () => '\\'
  ]
]

// A simple cache, because an ignore rule only has only one certain meaning
const regexCache = Object.create(null)

// @param {pattern}
const makeRegex = (pattern, negative, ignorecase) => {
  const r = regexCache[pattern]
  if (r) {
    return r
  }

  // const replacers = negative
  //   ? NEGATIVE_REPLACERS
  //   : POSITIVE_REPLACERS

  const source = REPLACERS.reduce(
    (prev, current) => prev.replace(current[0], current[1].bind(pattern)),
    pattern
  )

  return regexCache[pattern] = ignorecase
    ? new RegExp(source, 'i')
    : new RegExp(source)
}

const isString = subject => typeof subject === 'string'

// > A blank line matches no files, so it can serve as a separator for readability.
const checkPattern = pattern => pattern
  && isString(pattern)
  && !REGEX_TEST_BLANK_LINE.test(pattern)

  // > A line starting with # serves as a comment.
  && pattern.indexOf('#') !== 0

const splitPattern = pattern => pattern.split(REGEX_SPLITALL_CRLF)

class IgnoreRule {
  constructor (
    origin,
    pattern,
    negative,
    regex
  ) {
    this.origin = origin
    this.pattern = pattern
    this.negative = negative
    this.regex = regex
  }
}

const createRule = (pattern, ignorecase) => {
  const origin = pattern
  let negative = false

  // > An optional prefix "!" which negates the pattern;
  if (pattern.indexOf('!') === 0) {
    negative = true
    pattern = pattern.substr(1)
  }

  pattern = pattern
  // > Put a backslash ("\") in front of the first "!" for patterns that
  // >   begin with a literal "!", for example, `"\!important!.txt"`.
  .replace(REGEX_REPLACE_LEADING_EXCAPED_EXCLAMATION, '!')
  // > Put a backslash ("\") in front of the first hash for patterns that
  // >   begin with a hash.
  .replace(REGEX_REPLACE_LEADING_EXCAPED_HASH, '#')

  const regex = makeRegex(pattern, negative, ignorecase)

  return new IgnoreRule(
    origin,
    pattern,
    negative,
    regex
  )
}

const throwError = (message, Ctor) => {
  throw new Ctor(message)
}

const checkPath = (path, originalPath, doThrow) => {
  if (!isString(path)) {
    return doThrow(
      `path must be a string, but got \`${originalPath}\``,
      TypeError
    )
  }

  // We don't know if we should ignore '', so throw
  if (!path) {
    return doThrow(`path must not be empty`, TypeError)
  }

  // Check if it is a relative path
  if (checkPath.isNotRelative(path)) {
    const r = '`path.relative()`d'
    return doThrow(
      `path should be a ${r} string, but got "${originalPath}"`,
      RangeError
    )
  }

  return true
}

const isNotRelative = path => REGEX_TEST_INVALID_PATH.test(path)

checkPath.isNotRelative = isNotRelative
checkPath.convert = p => p

class Ignore {
  constructor ({
    ignorecase = true
  } = {}) {
    this._rules = []
    this._ignorecase = ignorecase
    define(this, KEY_IGNORE, true)
    this._initCache()
  }

  _initCache () {
    this._ignoreCache = Object.create(null)
    this._testCache = Object.create(null)
  }

  _addPattern (pattern) {
    // #32
    if (pattern && pattern[KEY_IGNORE]) {
      this._rules = this._rules.concat(pattern._rules)
      this._added = true
      return
    }

    if (checkPattern(pattern)) {
      const rule = createRule(pattern, this._ignorecase)
      this._added = true
      this._rules.push(rule)
    }
  }

  // @param {Array<string> | string | Ignore} pattern
  add (pattern) {
    this._added = false

    makeArray(
      isString(pattern)
        ? splitPattern(pattern)
        : pattern
    ).forEach(this._addPattern, this)

    // Some rules have just added to the ignore,
    // making the behavior changed.
    if (this._added) {
      this._initCache()
    }

    return this
  }

  // legacy
  addPattern (pattern) {
    return this.add(pattern)
  }

  //          |           ignored : unignored
  // negative |   0:0   |   0:1   |   1:0   |   1:1
  // -------- | ------- | ------- | ------- | --------
  //     0    |  TEST   |  TEST   |  SKIP   |    X
  //     1    |  TESTIF |  SKIP   |  TEST   |    X

  // - SKIP: always skip
  // - TEST: always test
  // - TESTIF: only test if checkUnignored
  // - X: that never happen

  // @param {boolean} whether should check if the path is unignored,
  //   setting `checkUnignored` to `false` could reduce additional
  //   path matching.

  // @returns {TestResult} true if a file is ignored
  _testOne (path, checkUnignored) {
    let ignored = false
    let unignored = false

    this._rules.forEach(rule => {
      const {negative} = rule
      if (
        unignored === negative && ignored !== unignored
        || negative && !ignored && !unignored && !checkUnignored
      ) {
        return
      }

      const matched = rule.regex.test(path)

      if (matched) {
        ignored = !negative
        unignored = negative
      }
    })

    return {
      ignored,
      unignored
    }
  }

  // @returns {TestResult}
  _test (originalPath, cache, checkUnignored, slices) {
    const path = originalPath
      // Supports nullable path
      && checkPath.convert(originalPath)

    checkPath(path, originalPath, throwError)

    return this._t(path, cache, checkUnignored, slices)
  }

  _t (path, cache, checkUnignored, slices) {
    if (path in cache) {
      return cache[path]
    }

    if (!slices) {
      // path/to/a.js
      // ['path', 'to', 'a.js']
      slices = path.split(SLASH)
    }

    slices.pop()

    // If the path has no parent directory, just test it
    if (!slices.length) {
      return cache[path] = this._testOne(path, checkUnignored)
    }

    const parent = this._t(
      slices.join(SLASH) + SLASH,
      cache,
      checkUnignored,
      slices
    )

    // If the path contains a parent directory, check the parent first
    return cache[path] = parent.ignored
      // > It is not possible to re-include a file if a parent directory of
      // >   that file is excluded.
      ? parent
      : this._testOne(path, checkUnignored)
  }

  ignores (path) {
    return this._test(path, this._ignoreCache, false).ignored
  }

  createFilter () {
    return path => !this.ignores(path)
  }

  filter (paths) {
    return makeArray(paths).filter(this.createFilter())
  }

  // @returns {TestResult}
  test (path) {
    return this._test(path, this._testCache, true)
  }
}

const factory = options => new Ignore(options)

const returnFalse = () => false

const isPathValid = path =>
  checkPath(path && checkPath.convert(path), path, returnFalse)

factory.isPathValid = isPathValid

// Fixes typescript
factory.default = factory

module.exports = factory

// Windows
// --------------------------------------------------------------
/* istanbul ignore if  */
if (
  // Detect `process` so that it can run in browsers.
  typeof process !== 'undefined'
  && (
    process.env && process.env.IGNORE_TEST_WIN32
    || process.platform === 'win32'
  )
) {
  /* eslint no-control-regex: "off" */
  const makePosix = str => /^\\\\\?\\/.test(str)
  || /["<>|\u0000-\u001F]+/u.test(str)
    ? str
    : str.replace(/\\/g, '/')

  checkPath.convert = makePosix

  // 'C:\\foo'     <- 'C:\\foo' has been converted to 'C:/'
  // 'd:\\foo'
  const REGIX_IS_WINDOWS_PATH_ABSOLUTE = /^[a-z]:\//i
  checkPath.isNotRelative = path =>
    REGIX_IS_WINDOWS_PATH_ABSOLUTE.test(path)
    || isNotRelative(path)
}

}).call(this,require('_process'))
},{"_process":15}],15:[function(require,module,exports){
// shim for using process in browser
var process = module.exports = {};

// cached from whatever global is present so that test runners that stub it
// don't break things.  But we need to wrap it in a try catch in case it is
// wrapped in strict mode code which doesn't define any globals.  It's inside a
// function because try/catches deoptimize in certain engines.

var cachedSetTimeout;
var cachedClearTimeout;

function defaultSetTimout() {
    throw new Error('setTimeout has not been defined');
}
function defaultClearTimeout () {
    throw new Error('clearTimeout has not been defined');
}
(function () {
    try {
        if (typeof setTimeout === 'function') {
            cachedSetTimeout = setTimeout;
        } else {
            cachedSetTimeout = defaultSetTimout;
        }
    } catch (e) {
        cachedSetTimeout = defaultSetTimout;
    }
    try {
        if (typeof clearTimeout === 'function') {
            cachedClearTimeout = clearTimeout;
        } else {
            cachedClearTimeout = defaultClearTimeout;
        }
    } catch (e) {
        cachedClearTimeout = defaultClearTimeout;
    }
} ())
function runTimeout(fun) {
    if (cachedSetTimeout === setTimeout) {
        //normal enviroments in sane situations
        return setTimeout(fun, 0);
    }
    // if setTimeout wasn't available but was latter defined
    if ((cachedSetTimeout === defaultSetTimout || !cachedSetTimeout) && setTimeout) {
        cachedSetTimeout = setTimeout;
        return setTimeout(fun, 0);
    }
    try {
        // when when somebody has screwed with setTimeout but no I.E. maddness
        return cachedSetTimeout(fun, 0);
    } catch(e){
        try {
            // When we are in I.E. but the script has been evaled so I.E. doesn't trust the global object when called normally
            return cachedSetTimeout.call(null, fun, 0);
        } catch(e){
            // same as above but when it's a version of I.E. that must have the global object for 'this', hopfully our context correct otherwise it will throw a global error
            return cachedSetTimeout.call(this, fun, 0);
        }
    }


}
function runClearTimeout(marker) {
    if (cachedClearTimeout === clearTimeout) {
        //normal enviroments in sane situations
        return clearTimeout(marker);
    }
    // if clearTimeout wasn't available but was latter defined
    if ((cachedClearTimeout === defaultClearTimeout || !cachedClearTimeout) && clearTimeout) {
        cachedClearTimeout = clearTimeout;
        return clearTimeout(marker);
    }
    try {
        // when when somebody has screwed with setTimeout but no I.E. maddness
        return cachedClearTimeout(marker);
    } catch (e){
        try {
            // When we are in I.E. but the script has been evaled so I.E. doesn't  trust the global object when called normally
            return cachedClearTimeout.call(null, marker);
        } catch (e){
            // same as above but when it's a version of I.E. that must have the global object for 'this', hopfully our context correct otherwise it will throw a global error.
            // Some versions of I.E. have different rules for clearTimeout vs setTimeout
            return cachedClearTimeout.call(this, marker);
        }
    }



}
var queue = [];
var draining = false;
var currentQueue;
var queueIndex = -1;

function cleanUpNextTick() {
    if (!draining || !currentQueue) {
        return;
    }
    draining = false;
    if (currentQueue.length) {
        queue = currentQueue.concat(queue);
    } else {
        queueIndex = -1;
    }
    if (queue.length) {
        drainQueue();
    }
}

function drainQueue() {
    if (draining) {
        return;
    }
    var timeout = runTimeout(cleanUpNextTick);
    draining = true;

    var len = queue.length;
    while(len) {
        currentQueue = queue;
        queue = [];
        while (++queueIndex < len) {
            if (currentQueue) {
                currentQueue[queueIndex].run();
            }
        }
        queueIndex = -1;
        len = queue.length;
    }
    currentQueue = null;
    draining = false;
    runClearTimeout(timeout);
}

process.nextTick = function (fun) {
    var args = new Array(arguments.length - 1);
    if (arguments.length > 1) {
        for (var i = 1; i < arguments.length; i++) {
            args[i - 1] = arguments[i];
        }
    }
    queue.push(new Item(fun, args));
    if (queue.length === 1 && !draining) {
        runTimeout(drainQueue);
    }
};

// v8 likes predictible objects
function Item(fun, array) {
    this.fun = fun;
    this.array = array;
}
Item.prototype.run = function () {
    this.fun.apply(null, this.array);
};
process.title = 'browser';
process.browser = true;
process.env = {};
process.argv = [];
process.version = ''; // empty string to avoid regexp issues
process.versions = {};

function noop() {}

process.on = noop;
process.addListener = noop;
process.once = noop;
process.off = noop;
process.removeListener = noop;
process.removeAllListeners = noop;
process.emit = noop;
process.prependListener = noop;
process.prependOnceListener = noop;

process.listeners = function (name) { return [] }

process.binding = function (name) {
    throw new Error('process.binding is not supported');
};

process.cwd = function () { return '/' };
process.chdir = function (dir) {
    throw new Error('process.chdir is not supported');
};
process.umask = function() { return 0; };

},{}],16:[function(require,module,exports){
(function (global){
/*! https://mths.be/punycode v1.4.1 by @mathias */
;(function(root) {

	/** Detect free variables */
	var freeExports = typeof exports == 'object' && exports &&
		!exports.nodeType && exports;
	var freeModule = typeof module == 'object' && module &&
		!module.nodeType && module;
	var freeGlobal = typeof global == 'object' && global;
	if (
		freeGlobal.global === freeGlobal ||
		freeGlobal.window === freeGlobal ||
		freeGlobal.self === freeGlobal
	) {
		root = freeGlobal;
	}

	/**
	 * The `punycode` object.
	 * @name punycode
	 * @type Object
	 */
	var punycode,

	/** Highest positive signed 32-bit float value */
	maxInt = 2147483647, // aka. 0x7FFFFFFF or 2^31-1

	/** Bootstring parameters */
	base = 36,
	tMin = 1,
	tMax = 26,
	skew = 38,
	damp = 700,
	initialBias = 72,
	initialN = 128, // 0x80
	delimiter = '-', // '\x2D'

	/** Regular expressions */
	regexPunycode = /^xn--/,
	regexNonASCII = /[^\x20-\x7E]/, // unprintable ASCII chars + non-ASCII chars
	regexSeparators = /[\x2E\u3002\uFF0E\uFF61]/g, // RFC 3490 separators

	/** Error messages */
	errors = {
		'overflow': 'Overflow: input needs wider integers to process',
		'not-basic': 'Illegal input >= 0x80 (not a basic code point)',
		'invalid-input': 'Invalid input'
	},

	/** Convenience shortcuts */
	baseMinusTMin = base - tMin,
	floor = Math.floor,
	stringFromCharCode = String.fromCharCode,

	/** Temporary variable */
	key;

	/*--------------------------------------------------------------------------*/

	/**
	 * A generic error utility function.
	 * @private
	 * @param {String} type The error type.
	 * @returns {Error} Throws a `RangeError` with the applicable error message.
	 */
	function error(type) {
		throw new RangeError(errors[type]);
	}

	/**
	 * A generic `Array#map` utility function.
	 * @private
	 * @param {Array} array The array to iterate over.
	 * @param {Function} callback The function that gets called for every array
	 * item.
	 * @returns {Array} A new array of values returned by the callback function.
	 */
	function map(array, fn) {
		var length = array.length;
		var result = [];
		while (length--) {
			result[length] = fn(array[length]);
		}
		return result;
	}

	/**
	 * A simple `Array#map`-like wrapper to work with domain name strings or email
	 * addresses.
	 * @private
	 * @param {String} domain The domain name or email address.
	 * @param {Function} callback The function that gets called for every
	 * character.
	 * @returns {Array} A new string of characters returned by the callback
	 * function.
	 */
	function mapDomain(string, fn) {
		var parts = string.split('@');
		var result = '';
		if (parts.length > 1) {
			// In email addresses, only the domain name should be punycoded. Leave
			// the local part (i.e. everything up to `@`) intact.
			result = parts[0] + '@';
			string = parts[1];
		}
		// Avoid `split(regex)` for IE8 compatibility. See #17.
		string = string.replace(regexSeparators, '\x2E');
		var labels = string.split('.');
		var encoded = map(labels, fn).join('.');
		return result + encoded;
	}

	/**
	 * Creates an array containing the numeric code points of each Unicode
	 * character in the string. While JavaScript uses UCS-2 internally,
	 * this function will convert a pair of surrogate halves (each of which
	 * UCS-2 exposes as separate characters) into a single code point,
	 * matching UTF-16.
	 * @see `punycode.ucs2.encode`
	 * @see <https://mathiasbynens.be/notes/javascript-encoding>
	 * @memberOf punycode.ucs2
	 * @name decode
	 * @param {String} string The Unicode input string (UCS-2).
	 * @returns {Array} The new array of code points.
	 */
	function ucs2decode(string) {
		var output = [],
		    counter = 0,
		    length = string.length,
		    value,
		    extra;
		while (counter < length) {
			value = string.charCodeAt(counter++);
			if (value >= 0xD800 && value <= 0xDBFF && counter < length) {
				// high surrogate, and there is a next character
				extra = string.charCodeAt(counter++);
				if ((extra & 0xFC00) == 0xDC00) { // low surrogate
					output.push(((value & 0x3FF) << 10) + (extra & 0x3FF) + 0x10000);
				} else {
					// unmatched surrogate; only append this code unit, in case the next
					// code unit is the high surrogate of a surrogate pair
					output.push(value);
					counter--;
				}
			} else {
				output.push(value);
			}
		}
		return output;
	}

	/**
	 * Creates a string based on an array of numeric code points.
	 * @see `punycode.ucs2.decode`
	 * @memberOf punycode.ucs2
	 * @name encode
	 * @param {Array} codePoints The array of numeric code points.
	 * @returns {String} The new Unicode string (UCS-2).
	 */
	function ucs2encode(array) {
		return map(array, function(value) {
			var output = '';
			if (value > 0xFFFF) {
				value -= 0x10000;
				output += stringFromCharCode(value >>> 10 & 0x3FF | 0xD800);
				value = 0xDC00 | value & 0x3FF;
			}
			output += stringFromCharCode(value);
			return output;
		}).join('');
	}

	/**
	 * Converts a basic code point into a digit/integer.
	 * @see `digitToBasic()`
	 * @private
	 * @param {Number} codePoint The basic numeric code point value.
	 * @returns {Number} The numeric value of a basic code point (for use in
	 * representing integers) in the range `0` to `base - 1`, or `base` if
	 * the code point does not represent a value.
	 */
	function basicToDigit(codePoint) {
		if (codePoint - 48 < 10) {
			return codePoint - 22;
		}
		if (codePoint - 65 < 26) {
			return codePoint - 65;
		}
		if (codePoint - 97 < 26) {
			return codePoint - 97;
		}
		return base;
	}

	/**
	 * Converts a digit/integer into a basic code point.
	 * @see `basicToDigit()`
	 * @private
	 * @param {Number} digit The numeric value of a basic code point.
	 * @returns {Number} The basic code point whose value (when used for
	 * representing integers) is `digit`, which needs to be in the range
	 * `0` to `base - 1`. If `flag` is non-zero, the uppercase form is
	 * used; else, the lowercase form is used. The behavior is undefined
	 * if `flag` is non-zero and `digit` has no uppercase form.
	 */
	function digitToBasic(digit, flag) {
		//  0..25 map to ASCII a..z or A..Z
		// 26..35 map to ASCII 0..9
		return digit + 22 + 75 * (digit < 26) - ((flag != 0) << 5);
	}

	/**
	 * Bias adaptation function as per section 3.4 of RFC 3492.
	 * https://tools.ietf.org/html/rfc3492#section-3.4
	 * @private
	 */
	function adapt(delta, numPoints, firstTime) {
		var k = 0;
		delta = firstTime ? floor(delta / damp) : delta >> 1;
		delta += floor(delta / numPoints);
		for (/* no initialization */; delta > baseMinusTMin * tMax >> 1; k += base) {
			delta = floor(delta / baseMinusTMin);
		}
		return floor(k + (baseMinusTMin + 1) * delta / (delta + skew));
	}

	/**
	 * Converts a Punycode string of ASCII-only symbols to a string of Unicode
	 * symbols.
	 * @memberOf punycode
	 * @param {String} input The Punycode string of ASCII-only symbols.
	 * @returns {String} The resulting string of Unicode symbols.
	 */
	function decode(input) {
		// Don't use UCS-2
		var output = [],
		    inputLength = input.length,
		    out,
		    i = 0,
		    n = initialN,
		    bias = initialBias,
		    basic,
		    j,
		    index,
		    oldi,
		    w,
		    k,
		    digit,
		    t,
		    /** Cached calculation results */
		    baseMinusT;

		// Handle the basic code points: let `basic` be the number of input code
		// points before the last delimiter, or `0` if there is none, then copy
		// the first basic code points to the output.

		basic = input.lastIndexOf(delimiter);
		if (basic < 0) {
			basic = 0;
		}

		for (j = 0; j < basic; ++j) {
			// if it's not a basic code point
			if (input.charCodeAt(j) >= 0x80) {
				error('not-basic');
			}
			output.push(input.charCodeAt(j));
		}

		// Main decoding loop: start just after the last delimiter if any basic code
		// points were copied; start at the beginning otherwise.

		for (index = basic > 0 ? basic + 1 : 0; index < inputLength; /* no final expression */) {

			// `index` is the index of the next character to be consumed.
			// Decode a generalized variable-length integer into `delta`,
			// which gets added to `i`. The overflow checking is easier
			// if we increase `i` as we go, then subtract off its starting
			// value at the end to obtain `delta`.
			for (oldi = i, w = 1, k = base; /* no condition */; k += base) {

				if (index >= inputLength) {
					error('invalid-input');
				}

				digit = basicToDigit(input.charCodeAt(index++));

				if (digit >= base || digit > floor((maxInt - i) / w)) {
					error('overflow');
				}

				i += digit * w;
				t = k <= bias ? tMin : (k >= bias + tMax ? tMax : k - bias);

				if (digit < t) {
					break;
				}

				baseMinusT = base - t;
				if (w > floor(maxInt / baseMinusT)) {
					error('overflow');
				}

				w *= baseMinusT;

			}

			out = output.length + 1;
			bias = adapt(i - oldi, out, oldi == 0);

			// `i` was supposed to wrap around from `out` to `0`,
			// incrementing `n` each time, so we'll fix that now:
			if (floor(i / out) > maxInt - n) {
				error('overflow');
			}

			n += floor(i / out);
			i %= out;

			// Insert `n` at position `i` of the output
			output.splice(i++, 0, n);

		}

		return ucs2encode(output);
	}

	/**
	 * Converts a string of Unicode symbols (e.g. a domain name label) to a
	 * Punycode string of ASCII-only symbols.
	 * @memberOf punycode
	 * @param {String} input The string of Unicode symbols.
	 * @returns {String} The resulting Punycode string of ASCII-only symbols.
	 */
	function encode(input) {
		var n,
		    delta,
		    handledCPCount,
		    basicLength,
		    bias,
		    j,
		    m,
		    q,
		    k,
		    t,
		    currentValue,
		    output = [],
		    /** `inputLength` will hold the number of code points in `input`. */
		    inputLength,
		    /** Cached calculation results */
		    handledCPCountPlusOne,
		    baseMinusT,
		    qMinusT;

		// Convert the input in UCS-2 to Unicode
		input = ucs2decode(input);

		// Cache the length
		inputLength = input.length;

		// Initialize the state
		n = initialN;
		delta = 0;
		bias = initialBias;

		// Handle the basic code points
		for (j = 0; j < inputLength; ++j) {
			currentValue = input[j];
			if (currentValue < 0x80) {
				output.push(stringFromCharCode(currentValue));
			}
		}

		handledCPCount = basicLength = output.length;

		// `handledCPCount` is the number of code points that have been handled;
		// `basicLength` is the number of basic code points.

		// Finish the basic string - if it is not empty - with a delimiter
		if (basicLength) {
			output.push(delimiter);
		}

		// Main encoding loop:
		while (handledCPCount < inputLength) {

			// All non-basic code points < n have been handled already. Find the next
			// larger one:
			for (m = maxInt, j = 0; j < inputLength; ++j) {
				currentValue = input[j];
				if (currentValue >= n && currentValue < m) {
					m = currentValue;
				}
			}

			// Increase `delta` enough to advance the decoder's <n,i> state to <m,0>,
			// but guard against overflow
			handledCPCountPlusOne = handledCPCount + 1;
			if (m - n > floor((maxInt - delta) / handledCPCountPlusOne)) {
				error('overflow');
			}

			delta += (m - n) * handledCPCountPlusOne;
			n = m;

			for (j = 0; j < inputLength; ++j) {
				currentValue = input[j];

				if (currentValue < n && ++delta > maxInt) {
					error('overflow');
				}

				if (currentValue == n) {
					// Represent delta as a generalized variable-length integer
					for (q = delta, k = base; /* no condition */; k += base) {
						t = k <= bias ? tMin : (k >= bias + tMax ? tMax : k - bias);
						if (q < t) {
							break;
						}
						qMinusT = q - t;
						baseMinusT = base - t;
						output.push(
							stringFromCharCode(digitToBasic(t + qMinusT % baseMinusT, 0))
						);
						q = floor(qMinusT / baseMinusT);
					}

					output.push(stringFromCharCode(digitToBasic(q, 0)));
					bias = adapt(delta, handledCPCountPlusOne, handledCPCount == basicLength);
					delta = 0;
					++handledCPCount;
				}
			}

			++delta;
			++n;

		}
		return output.join('');
	}

	/**
	 * Converts a Punycode string representing a domain name or an email address
	 * to Unicode. Only the Punycoded parts of the input will be converted, i.e.
	 * it doesn't matter if you call it on a string that has already been
	 * converted to Unicode.
	 * @memberOf punycode
	 * @param {String} input The Punycoded domain name or email address to
	 * convert to Unicode.
	 * @returns {String} The Unicode representation of the given Punycode
	 * string.
	 */
	function toUnicode(input) {
		return mapDomain(input, function(string) {
			return regexPunycode.test(string)
				? decode(string.slice(4).toLowerCase())
				: string;
		});
	}

	/**
	 * Converts a Unicode string representing a domain name or an email address to
	 * Punycode. Only the non-ASCII parts of the domain name will be converted,
	 * i.e. it doesn't matter if you call it with a domain that's already in
	 * ASCII.
	 * @memberOf punycode
	 * @param {String} input The domain name or email address to convert, as a
	 * Unicode string.
	 * @returns {String} The Punycode representation of the given domain name or
	 * email address.
	 */
	function toASCII(input) {
		return mapDomain(input, function(string) {
			return regexNonASCII.test(string)
				? 'xn--' + encode(string)
				: string;
		});
	}

	/*--------------------------------------------------------------------------*/

	/** Define the public API */
	punycode = {
		/**
		 * A string representing the current Punycode.js version number.
		 * @memberOf punycode
		 * @type String
		 */
		'version': '1.4.1',
		/**
		 * An object of methods to convert from JavaScript's internal character
		 * representation (UCS-2) to Unicode code points, and back.
		 * @see <https://mathiasbynens.be/notes/javascript-encoding>
		 * @memberOf punycode
		 * @type Object
		 */
		'ucs2': {
			'decode': ucs2decode,
			'encode': ucs2encode
		},
		'decode': decode,
		'encode': encode,
		'toASCII': toASCII,
		'toUnicode': toUnicode
	};

	/** Expose `punycode` */
	// Some AMD build optimizers, like r.js, check for specific condition patterns
	// like the following:
	if (
		typeof define == 'function' &&
		typeof define.amd == 'object' &&
		define.amd
	) {
		define('punycode', function() {
			return punycode;
		});
	} else if (freeExports && freeModule) {
		if (module.exports == freeExports) {
			// in Node.js, io.js, or RingoJS v0.8.0+
			freeModule.exports = punycode;
		} else {
			// in Narwhal or RingoJS v0.7.0-
			for (key in punycode) {
				punycode.hasOwnProperty(key) && (freeExports[key] = punycode[key]);
			}
		}
	} else {
		// in Rhino or a web browser
		root.punycode = punycode;
	}

}(this));

}).call(this,typeof global !== "undefined" ? global : typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : {})
},{}],17:[function(require,module,exports){
(function (Buffer){
(function() {
  var crypt = require('crypt'),
      utf8 = require('charenc').utf8,
      bin = require('charenc').bin,

  // The core
  sha1 = function (message) {
    // Convert to byte array
    if (message.constructor == String)
      message = utf8.stringToBytes(message);
    else if (typeof Buffer !== 'undefined' && typeof Buffer.isBuffer == 'function' && Buffer.isBuffer(message))
      message = Array.prototype.slice.call(message, 0);
    else if (!Array.isArray(message))
      message = message.toString();

    // otherwise assume byte array

    var m  = crypt.bytesToWords(message),
        l  = message.length * 8,
        w  = [],
        H0 =  1732584193,
        H1 = -271733879,
        H2 = -1732584194,
        H3 =  271733878,
        H4 = -1009589776;

    // Padding
    m[l >> 5] |= 0x80 << (24 - l % 32);
    m[((l + 64 >>> 9) << 4) + 15] = l;

    for (var i = 0; i < m.length; i += 16) {
      var a = H0,
          b = H1,
          c = H2,
          d = H3,
          e = H4;

      for (var j = 0; j < 80; j++) {

        if (j < 16)
          w[j] = m[i + j];
        else {
          var n = w[j - 3] ^ w[j - 8] ^ w[j - 14] ^ w[j - 16];
          w[j] = (n << 1) | (n >>> 31);
        }

        var t = ((H0 << 5) | (H0 >>> 27)) + H4 + (w[j] >>> 0) + (
                j < 20 ? (H1 & H2 | ~H1 & H3) + 1518500249 :
                j < 40 ? (H1 ^ H2 ^ H3) + 1859775393 :
                j < 60 ? (H1 & H2 | H1 & H3 | H2 & H3) - 1894007588 :
                         (H1 ^ H2 ^ H3) - 899497514);

        H4 = H3;
        H3 = H2;
        H2 = (H1 << 30) | (H1 >>> 2);
        H1 = H0;
        H0 = t;
      }

      H0 += a;
      H1 += b;
      H2 += c;
      H3 += d;
      H4 += e;
    }

    return [H0, H1, H2, H3, H4];
  },

  // Public API
  api = function (message, options) {
    var digestbytes = crypt.wordsToBytes(sha1(message));
    return options && options.asBytes ? digestbytes :
        options && options.asString ? bin.bytesToString(digestbytes) :
        crypt.bytesToHex(digestbytes);
  };

  api._blocksize = 16;
  api._digestsize = 20;

  module.exports = api;
})();

}).call(this,require("buffer").Buffer)
},{"buffer":6,"charenc":7,"crypt":9}],18:[function(require,module,exports){
(function (setImmediate,clearImmediate){
var nextTick = require('process/browser.js').nextTick;
var apply = Function.prototype.apply;
var slice = Array.prototype.slice;
var immediateIds = {};
var nextImmediateId = 0;

// DOM APIs, for completeness

exports.setTimeout = function() {
  return new Timeout(apply.call(setTimeout, window, arguments), clearTimeout);
};
exports.setInterval = function() {
  return new Timeout(apply.call(setInterval, window, arguments), clearInterval);
};
exports.clearTimeout =
exports.clearInterval = function(timeout) { timeout.close(); };

function Timeout(id, clearFn) {
  this._id = id;
  this._clearFn = clearFn;
}
Timeout.prototype.unref = Timeout.prototype.ref = function() {};
Timeout.prototype.close = function() {
  this._clearFn.call(window, this._id);
};

// Does not start the time, just sets up the members needed.
exports.enroll = function(item, msecs) {
  clearTimeout(item._idleTimeoutId);
  item._idleTimeout = msecs;
};

exports.unenroll = function(item) {
  clearTimeout(item._idleTimeoutId);
  item._idleTimeout = -1;
};

exports._unrefActive = exports.active = function(item) {
  clearTimeout(item._idleTimeoutId);

  var msecs = item._idleTimeout;
  if (msecs >= 0) {
    item._idleTimeoutId = setTimeout(function onTimeout() {
      if (item._onTimeout)
        item._onTimeout();
    }, msecs);
  }
};

// That's not how node.js implements it but the exposed api is the same.
exports.setImmediate = typeof setImmediate === "function" ? setImmediate : function(fn) {
  var id = nextImmediateId++;
  var args = arguments.length < 2 ? false : slice.call(arguments, 1);

  immediateIds[id] = true;

  nextTick(function onNextTick() {
    if (immediateIds[id]) {
      // fn.call() is faster so we optimize for the common use-case
      // @see http://jsperf.com/call-apply-segu
      if (args) {
        fn.apply(null, args);
      } else {
        fn.call(null);
      }
      // Prevent ids from leaking
      exports.clearImmediate(id);
    }
  });

  return id;
};

exports.clearImmediate = typeof clearImmediate === "function" ? clearImmediate : function(id) {
  delete immediateIds[id];
};
}).call(this,require("timers").setImmediate,require("timers").clearImmediate)
},{"process/browser.js":15,"timers":18}]},{},[1]);

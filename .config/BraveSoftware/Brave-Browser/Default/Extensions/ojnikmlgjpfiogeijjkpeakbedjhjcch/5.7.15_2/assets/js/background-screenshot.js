/**
 * Background script (Screenshots).
 */

(function(root, factory) {
    if (typeof define === "function" && define.amd) {
        define(factory);
    } else if (typeof exports === "object") {
        module.exports = factory();
    } else {
        root.CloudAppBackgroundCaptureJs = factory();
    }
})(this, function() {
    

    const dropUrlBase = "https://share.getcloudapp.com/";

    // set default actionType to "sc"
    const actionType = "sc";

    const entirePage = {
        tabId: null,
        screenshotCanvas: null,
        screenshotContext: null,
        opennedInTab: false,
        scrollBy: 0,
        screenCount: 0,
        screenLimit: 10, // Number of allowed screenshots (entire page capture).
        size: {
            width: 0,
            height: 0,
        },
        originalParams: {
            overflow: "",
            scrollTop: 0,
        },

        /**
         * @description Initialize plugin
         */
        initialize() {
            this.screenshotCanvas = document.createElement("canvas");
            this.screenshotContext = this.screenshotCanvas.getContext("2d");
            this.bindEvents();
        },

        setTabId(tabId) {
            this.tabId = tabId;
        },

        /**
         * @description Bind plugin events
         */
        bindEvents() {
            // handle chrome requests
            chrome.runtime.onMessage.addListener(
                function(request, sender, callback) {
                    if (request.msg === "setPageDetails") {
                        this.tabId = sender.tab.id;
                        this.size = request.size;
                        this.scrollBy = request.scrollBy;
                        this.originalParams = request.originalParams;
                        this.screenCount = request.screenCount;

                        const ratio = _getDevicePixelRatio(
                            this.screenshotContext,
                        );
                        // set width & height of canvas element
                        this.screenshotCanvas.width = this.size.width * ratio;
                        this.screenshotCanvas.height = this.size.height * ratio;

                        this.scrollTo(0);
                    } else if (request.msg === "capturePage") {
                        this.capturePage(request.position, request.lastCapture);
                    }
                }.bind(this),
            );
        },

        /**
         * @description Send request to scroll page on given position
         * @param {Number} position
         */
        scrollTo(position) {
            chrome.tabs.sendMessage(this.tabId, {
                msg: "scrollPage",
                size: this.size,
                scrollBy: this.scrollBy,
                scrollTo: position,
                screenCount: this.screenCount,
            });
        },

        /**
         * @description Takes screenshot of visible area and merges it
         * @param {Number} position
         * @param {Boolean} lastCapture
         */
        capturePage(position, lastCapture) {
            const self = this;

            setTimeout(function() {
                chrome.tabs.captureVisibleTab(null, { format: "jpeg" }, function(
                    dataURI,
                ) {
                    const image = new Image();

                    if (typeof dataURI !== "undefined") {
                        image.onload = function() {
                            self.screenCount++;

                            // Only capture limited number of screens (inifinte page scolls)
                            // @TODO: Find a better solution to handle this. In some cases
                            // this still created empty image right where the app stopped capturing the screen.
                            if (self.screenCount >= self.screenLimit) {
                                let timer;
                                chrome.notifications.create(
                                    `cloudappError_${  Math.random()}`,
                                    {
                                        type: "basic",
                                        iconUrl: chrome.runtime.getURL(
                                            "assets/img/icons/warning_48.png",
                                        ),
                                        title: "Capture Warning",
                                        message:
                                            `The page is too long and we limited it to ${ 
                                            self.screenLimit 
                                            } screens only.`,
                                    },
                                );
                                lastCapture = true;
                            } else {
                                const ratio = _getDevicePixelRatio(
                                    self.screenshotContext,
                                );
                                self.screenshotContext.drawImage(
                                    image,
                                    0,
                                    position * ratio,
                                );
                            }

                            if (lastCapture) {
                                this.opennedInTab = true;
                                self.resetPage();
                                if (this.opennedInTab) {
                                    _cameraLikeFlash();
                                    // Generate screenshot filename.
                                    const dateTimeStamp = new Date().toISOString();
                                    const filename =
                                        `Screenshot-${  dateTimeStamp  }.jpeg`;
                                    chrome.storage.sync.get(["token"], function(
                                        config,
                                    ) {
                                        self.screenshotCanvas.toBlob(function(
                                            blob,
                                        ) {
                                            chrome.tabs.sendMessage(
                                                self.tabId,
                                                {
                                                    type:
                                                        "openCloudAppDashboard",
                                                },
                                            );

                                            CloudAppApi.setFileBlob(blob);
                                            CloudAppApi.setFileName(filename);
                                            const res = CloudAppApi.upload(
                                                config.token,
                                                function(response) {
                                                    // As soon as we get slug we should create a new tab.
                                                    if (response.slug != null) {
                                                        chrome.tabs.create({
                                                            url:
                                                                dropUrlBase +
                                                                response.slug,
                                                        });
                                                    } else {
                                                        _createNotification(
                                                            "failure",
                                                            null,
                                                            "Something went wrong. Looks like the image uploaded but the app failed to redirect",
                                                        );
                                                    }
                                                },
                                                function(response) {
                                                    // Upload successfully complete.
                                                    chrome.tabs.sendMessage(
                                                        self.tabId,
                                                        {
                                                            type:
                                                                "uploadProgressComplete",
                                                        },
                                                    );
                                                    _createNotification(
                                                        "success",
                                                        response,
                                                    );
                                                },
                                                function(message) {
                                                    // Could not upload the file.
                                                    _createNotification(
                                                        "failure",
                                                        null,
                                                        "Upload failed, please give another try",
                                                    );
                                                },
                                                function(total, loaded, drop) {
                                                    const progressPercentage = Math.floor(
                                                        (loaded / total) * 100,
                                                    );
                                                    chrome.tabs.query(
                                                        {
                                                            active: true,
                                                            currentWindow: true,
                                                        },
                                                        function(tabs) {
                                                            chrome.tabs.sendMessage(
                                                                tabs[0].id,
                                                                {
                                                                    type:
                                                                        "uploadProgress",
                                                                    percentage: progressPercentage,
                                                                    filename,
                                                                    drop,
                                                                },
                                                            );
                                                        },
                                                    );
                                                },
                                                "image/jpeg",
                                                actionType,
                                            );
                                        },
                                        "image/jpeg");
                                    });
                                    this.opennedInTab = false;
                                }
                            } else {
                                self.scrollTo(position + self.scrollBy);
                            }
                        };

                        image.src = dataURI;
                    } else {
                        chrome.tabs.sendMessage(self.tabId, {
                            msg: "showError",
                            originalParams: self.originalParams,
                        });
                    }
                    const lastErr = chrome.runtime.lastError;
                    if (typeof lastErr === "object") {
                        if (
                            lastErr.message.indexOf(
                                "Failed to capture tab: image readback failed",
                            ) !== -1
                        ) {
                            _createNotification(
                                "failure",
                                null,
                                "Could not read captured image. Please refresh page and try again",
                            );
                        }
                    }
                });
            }, 150);
        },

        /**
         * @description Send request to set original params of page
         */
        resetPage() {
            chrome.tabs.sendMessage(this.tabId, {
                msg: "resetPage",
                originalParams: this.originalParams,
            });
        },
    };

    const CloudAppBackgroundCaptureJs = function() {
        this.init();
    };

    /**
     * Initialize.
     */
    CloudAppBackgroundCaptureJs.prototype.init = function() {
        entirePage.initialize();
    };

    /**
     * Routine to run onMessage events.
     */
    CloudAppBackgroundCaptureJs.prototype.onMessage = function(request) {
        switch (request.type) {
            case "cloudapp-crop":
            case "cloudapp-visible-area":
                // We need a delay to let the Capture iframe hide before taking a screeshot.
                _cameraLikeFlash();
                setTimeout(function() {
                    _captureScreenshot(request.coords);
                }, 700);
                // Analytics.
                if (request.type == "cloudapp-crop") {
                    SegmentApi.track("Capture_CroppedArea");
                } else {
                    SegmentApi.track("Capture_VisibleArea");
                }
                break;

            // Code for entire page.
            case "cloudapp-entire-page":
                chrome.tabs.query(
                    { active: true, currentWindow: true },
                    function(tabs) {
                        chrome.tabs.sendMessage(tabs[0].id, {
                            msg: "getPageDetails",
                        });
                    },
                );
                // Analytics.
                SegmentApi.track("Capture_EntirePage");
                break;

            // Code for desktop screenshot.
            case "cloudapp-screenshot-desktop":
                _captureDesktopScreenshot();
                // Analytics.
                SegmentApi.track("Capture_Desktop");
                break;
        }
    };

    /**
     * Keyboard shorcuts.
     */
    CloudAppBackgroundCaptureJs.prototype.keyboardShortcuts = function(
        command,
    ) {
        if (command === "cloudapp-visible-area") {
            _cameraLikeFlash();
            chrome.windows.getCurrent(function(w) {
                _captureScreenshot({
                    x: 0,
                    y: 0,
                    w: window.screen.availWidth,
                    h: window.screen.availHeight,
                });
                // Analytics
                SegmentApi.track("Shortcut_VisibleArea");
            });
        }
        if (command === "cloudapp-entire-page") {
            chrome.windows.getCurrent(function(w) {
                chrome.tabs.query(
                    { active: true, currentWindow: true },
                    function(tabs) {
                        chrome.tabs.sendMessage(tabs[0].id, {
                            msg: "getPageDetails",
                        });
                    },
                );
            });
            // Analytics
            SegmentApi.track("Shortcut_EntirePage");
        }
    };

    /**
     * Image cropping is happening here.
     */
    function _cropData(str, coords, callback) {
        const image = new Image();
        image.src = str;
        image.onload = function() {
            const canvas = document.createElement("canvas");
            const ctx = canvas.getContext("2d");
            // Scale images (fix for retina displays).
            const ratio = _getDevicePixelRatio(ctx);
            canvas.width = coords.w * ratio;
            canvas.height = coords.h * ratio;
            // Now that its high res we need to compensate so our images can be drawn as
            // normal, by scaling everything up by the ratio.
            ctx.drawImage(
                image,
                coords.x * ratio,
                coords.y * ratio,
                coords.w * ratio,
                coords.h * ratio,
                0,
                0,
                coords.w * ratio,
                coords.h * ratio,
            );
            canvas.style.width = `${coords.w  }px`;
            canvas.style.height = `${coords.h  }px`;
            callback({ dataUri: canvas.toDataURL("image/jpeg") });
        };
    }

    /**
     * Detect device ratio.
     */
    function _getDevicePixelRatio(ctx) {
        const devicePixelRatio = window.devicePixelRatio || 1;
        const backingStoreRatio =
            ctx.webkitBackingStorePixelRatio ||
            ctx.mozBackingStorePixelRatio ||
            ctx.msBackingStorePixelRatio ||
            ctx.oBackingStorePixelRatio ||
            ctx.backingStorePixelRatio ||
            1;
        return devicePixelRatio / backingStoreRatio;
    }

    /**
     * Capture desktop screenshot.
     */
    function _captureDesktopScreenshot() {
        chrome.desktopCapture.chooseDesktopMedia(["screen", "window"], function(
            desktop_id,
        ) {
            navigator.webkitGetUserMedia(
                {
                    audio: false,
                    video: {
                        mandatory: {
                            chromeMediaSource: "desktop",
                            chromeMediaSourceId: desktop_id,
                            maxWidth: 4000,
                            maxHeight: 4000,
                        },
                    },
                },
                // Process received stream.
                function(stream) {
                    const mediaStream = stream;
                    const video = document.createElement("video");
                    video.addEventListener(
                        "loadedmetadata",
                        function() {
                            const canvas = document.createElement("canvas");
                            canvas.width = this.videoWidth;
                            canvas.height = this.videoHeight;
                            const ctx = canvas.getContext("2d");
                            ctx.drawImage(this, 0, 0);

                            _cameraLikeFlash();
                            setTimeout(function() {
                                _saveFile(canvas.toDataURL());
                                mediaStream
                                    .getTracks()
                                    .forEach(function(track) {
                                        track.stop();
                                    });
                            }, 700);
                        },
                        false,
                    );
                    video.srcObject = stream;
                    video.play();
                },
                function() {
                    console.log("Could not capture desktop screenshot");
                },
            );
        });
    }

    /**
     * Capture screenshot from a visibile browser tab.
     */
    function _captureScreenshot(coords) {
        chrome.tabs.captureVisibleTab(null, { format: "jpeg" }, function(data) {
            _cropData(data, coords, function(data) {
                _saveFile(data.dataUri);
            });
            const lastErr = chrome.runtime.lastError;
            if (typeof lastErr === "object") {
                if (
                    lastErr.message.indexOf(
                        "Failed to capture tab: image readback failed",
                    ) !== -1
                ) {
                    _createNotification(
                        "failure",
                        null,
                        "Could not read captured image. Please try again",
                    );
                }
            }
            return true;
        });
    }

    /**
     * Save the screenshot and pass image URL to the editor.
     */
    function _saveFile(dataURI) {
        // Generate screenshot filename.
        const dateTimeStamp = new Date().toISOString();
        const filename = `Screenshot-${  dateTimeStamp  }.jpeg`;

        // Convert base64 to raw binary data held in a string doesn't handle URLEncoded DataURIs.
        const byteString = atob(dataURI.split(",")[1]);

        // Separate out the mime component.
        const mimeString = dataURI
            .split(",")[0]
            .split(":")[1]
            .split(";")[0];

        // Write the bytes of the string to an ArrayBuffer
        const ab = new ArrayBuffer(byteString.length);
        const ia = new Uint8Array(ab);
        for (let i = 0; i < byteString.length; i++) {
            ia[i] = byteString.charCodeAt(i);
        }

        // Create a blob for writing to a file.
        const blob = new Blob([ab], { type: mimeString });

        // Callback when image write process ended.
        function onWriteEnd() {
            chrome.storage.sync.get(["token"], function(config) {
                chrome.tabs.query(
                    { active: true, currentWindow: true },
                    function(tabs) {
                        chrome.tabs.sendMessage(tabs[0].id, {
                            type: "openCloudAppDashboard",
                        });
                    },
                );

                CloudAppApi.setFileBlob(blob);
                CloudAppApi.setFileName(filename);
                const res = CloudAppApi.upload(
                    config.token,
                    function(response) {
                        // Open a new tab as soon as we get the slug.
                        if (response.slug != null) {
                            // Open in a new tab
                            // chrome.tabs.create( { url: dropUrlBase + response.slug } );
                        } else {
                            _createNotification(
                                "failure",
                                null,
                                "Image uploaded but the app failed to redirect. Please refresh page and try again.",
                            );
                        }
                    },
                    function(response) {
                        // Upload successfully complete.
                        chrome.tabs.query(
                            { active: true, currentWindow: true },
                            function(tabs) {
                                chrome.tabs.sendMessage(tabs[0].id, {
                                    type: "uploadProgressComplete",
                                });
                            },
                        );
                        _createNotification("success", response);
                        chrome.tabs.create({
                            url: dropUrlBase + response.slug,
                        });
                    },
                    function(message) {
                        // Could not upload the file.
                        _createNotification(
                            "failure",
                            null,
                            "Upload failed, please give another try",
                        );
                    },
                    function(total, loaded, drop) {
                        const progressPercentage = Math.floor(
                            (loaded / total) * 100,
                        );
                        chrome.tabs.query(
                            { active: true, currentWindow: true },
                            function(tabs) {
                                chrome.tabs.sendMessage(tabs[0].id, {
                                    type: "uploadProgress",
                                    percentage: progressPercentage,
                                    filename,
                                    drop,
                                });
                            },
                        );
                    },
                    "image/jpeg",
                    actionType,
                );
            });
        }

        // Error message callback.
        function errorHandler() {
            console.log("Could not save screenshot file");
        }

        // Create a blob for writing to a file.
        window.webkitRequestFileSystem(
            TEMPORARY,
            1024 * 1024,
            function(fs) {
                fs.root.getFile(
                    filename,
                    { create: true },
                    function(fileEntry) {
                        fileEntry.createWriter(function(fileWriter) {
                            fileWriter.onwriteend = onWriteEnd;
                            fileWriter.write(blob);
                        }, errorHandler);
                    },
                    errorHandler,
                );
            },
            errorHandler,
        );
    }

    /**
     * Progress box (photo camera like flash).
     */
    function _cameraLikeFlash() {
        chrome.tabs.query({ active: true, currentWindow: true }, function(
            tabs,
        ) {
            chrome.tabs.sendMessage(tabs[0].id, { type: "openCloudAppFlash" });
        });
    }

    // Show OS notification.
    function _createNotification(type, response, message) {
        const linkMap = {};
        const notificationId = `cloudappBgScreenshot_${  Math.random()}`;
        const dropUrl =
            response != null && response.slug != null
                ? dropUrlBase + response.slug
                : null;
        // Copy drop URL to clipboard.
        if (dropUrl !== null) {
            copyToClipboard(dropUrl);
        }
        chrome.notifications.create(
            notificationId,
            {
                type: "basic",
                iconUrl:
                    type == "success"
                        ? chrome.runtime.getURL(
                              "assets/img/icons/success_48.png",
                          )
                        : chrome.runtime.getURL(
                              "assets/img/icons/error_48.png",
                          ),
                title: type == "success" ? "Upload Complete!" : "Upload Failed",
                message:
                    type == "success"
                        ? "The sharing URL is copied to your clipboard"
                        : message,
            },
            function() {
                linkMap[notificationId] = dropUrl;
            },
        );
        // Open in a new tab
        if (dropUrl !== null) {
            // chrome.tabs.create( { url: dropUrl } );
        }
        // Make notification clickable and take a user to the uploaded capture.
        chrome.notifications.onClicked.addListener(function(notificationId) {
            const dropUrl =
                linkMap[notificationId] !== null ||
                linkMap[notificationId] !== "undefined"
                    ? linkMap[notificationId]
                    : null;
            if (dropUrl !== null) {
                const isValidURL = dropUrl.match(
                    /(http(s)?:\/\/.)?(www\.)?[-a-zA-Z0-9@:%._\+~#=]{2,256}\.[a-z]{2,6}\b([-a-zA-Z0-9@:%_\+.~#?&//=]*)/g,
                );
                if (isValidURL !== null) {
                    chrome.tabs.create({ url: linkMap[notificationId] });
                }
            }
        });
    }

    /**
     * Copies a string to the clipboard. Must be called from within an
     * event handler such as click. May return false if it failed, but
     * this is not always possible. Browser support for Chrome 43+,
     * Firefox 42+, Safari 10+, Edge and IE 10+.
     * IE: The clipboard feature may be disabled by an administrator. By
     * default a prompt is shown the first time the clipboard is
     * used (per session).
     *
     * Copied from https://stackoverflow.com/a/33928558/258899
     */
    function copyToClipboard(text) {
        if (window.clipboardData && window.clipboardData.setData) {
            // IE specific code path to prevent textarea being shown while dialog is visible.
            return clipboardData.setData("Text", text);
        } if (
            document.queryCommandSupported &&
            document.queryCommandSupported("copy")
        ) {
            const textarea = document.createElement("textarea");
            textarea.textContent = text;
            textarea.style.position = "fixed"; // Prevent scrolling to bottom of page in MS Edge.
            document.body.appendChild(textarea);
            textarea.select();
            try {
                return document.execCommand("copy"); // Security exception may be thrown by some browsers.
            } catch (ex) {
                console.warn("Copy to clipboard failed.", ex);
                return false;
            } finally {
                document.body.removeChild(textarea);
            }
        }
    }

    return CloudAppBackgroundCaptureJs;
});

const bgCaptureJs = new CloudAppBackgroundCaptureJs();

/**
 * Listen to shortcut commands.
 */
chrome.commands.onCommand.addListener(function(command) {
    bgCaptureJs.keyboardShortcuts(command);
});

/**
 * Listen to messages coming from the Capture iframe.
 */
chrome.runtime.onMessage.addListener(function(request, sender, sendResponse) {
    if (request.type !== "undefined") {
        bgCaptureJs.onMessage(request);
    }
    sendResponse({});
});

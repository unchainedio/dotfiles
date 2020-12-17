// This file is used with capture.html because capture.html, as a content
// script iframe, runs in a different context from our "regular" content
// script. All we can really do here is send messages.

// We send events only to the content script to make sure we can close the
// iframe before we send off any other events to the background scripts.

function registerClick(id) {
    document.getElementById(id)
        .addEventListener('click', function (e) {
            chrome.tabs.query({
                active: true,
                currentWindow: true
            }, function (tabs) {
                chrome.tabs.sendMessage(tabs[0].id, {
                    function: id,
                    data: null
                })
            })
        });
}

registerClick('cloudapp-capture-page');
registerClick('cloudapp-capture-visible');
registerClick('cloudapp-capture-desktop');
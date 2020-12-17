navigator.mediaDevices.getUserMedia({
        video: true,
        audio: true
    })
    .then((stream) => {
        chrome.runtime.sendMessage({
            function: "permissionGranted",
            data: null
        });
        console.debug("[permission.html] Permission granted.")

        stream.getTracks().forEach((track) => { track.stop() });
    })
    .catch((err) => {
        chrome.runtime.sendMessage({
            function: "permissionDenied",
            data: null
        });
        console.error("Could not get permission: ", err);
    });
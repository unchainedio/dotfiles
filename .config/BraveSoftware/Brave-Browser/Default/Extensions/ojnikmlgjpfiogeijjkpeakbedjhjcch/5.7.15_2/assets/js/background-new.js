function grabFrame(imgcap) {
    imgcap.grabFrame()
        .then(function (imageBitmap) {
            console.log('Grabbed frame:', imageBitmap);
        })
        .catch(function (error) {
            console.log('grabFrame() error: ', error);
        });
}


function startCapture(streamId) {
    // https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia
    console.log("Starting capture; stream ID: " + streamId);
    navigator.mediaDevices.getUserMedia({
        video: true
        /*
        video: {
            mandatory: {
              chromeMediaSource: 'desktop',
              chromeMediaSourceId: streamId,
            }
          }
          */
    }).then(mediaStream => {
        console.log("Grabbing frame");
        console.log("Stream ID:" + streamId)
        var track = mediaStream.getVideoTracks()[0];
        console.log("Track:" + track);
        var imageCapture = new ImageCapture(track);
        grabFrame(imageCapture);
        //        mediaStream.removeTrack(track);
        console.log("Track removed.");
    });
}

function recordVideo() {
    chrome.desktopCapture.chooseDesktopMedia(["screen"], (streamId) => {
        navigator.mediaDevices.getUserMedia({
            video: {
                mandatory: {
                    chromeMediaSource: 'desktop',
                    chromeMediaSourceId: streamId
                }
            },
            audio: false
        }).then(async function (stream) {
            let recorder = RecordRTC(stream, {
                type: 'video'
            });
            recorder.startRecording();

            const sleep = m => new Promise(r => setTimeout(r, m));
            console.log("Waiting ...")
            await sleep(3000);
            console.log("Done waiting ...")

            recorder.stopRecording(function () {
                let blob = recorder.getBlob();
                invokeSaveAsDialog(blob);
            });

            console.log("Stopping media tracks.")
            stream.getTracks().forEach(function (track) {
                track.stop();
            });
        });
    });
}


chrome.commands.onCommand.addListener(async function (command) {
    if (command === "cloudapp-screenshot-tabiiiiii") {
        chrome.desktopCapture.chooseDesktopMedia(["tab"], startCapture);
    } else if (command === "cloudapp-screenshot-tab") {
        recordVideo();
    }
});
//      chrome.tabCapture.getMediaStreamId(startCapture);
//     chrome.desktopCapture.chooseDesktopMedia(["tab"], startCapture);
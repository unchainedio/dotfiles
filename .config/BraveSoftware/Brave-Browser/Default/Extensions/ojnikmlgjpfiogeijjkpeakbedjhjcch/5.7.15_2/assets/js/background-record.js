/**
 * Background script (Record).
 */

(function( root, factory ) {
  if ( typeof define === 'function' && define.amd ) {
    define( factory );
  } else if ( typeof exports === 'object' ) {
    module.exports = factory();
  } else {
    root.CloudAppBackgroundRecordJs = factory();
  }
}( this, function() {

  "use strict";

  var dropUrlBase = 'https://share.getcloudapp.com/';

  var currentTabId;
  var currentConfig;

  var recorder;
  var mimeType = 'video/mp4';
  var ext = 'mp4';

  var screenStream;
  var micStream;

  // Recording icon animation
  var min = 1;
  var max = 5;
  var current = min;

  // set default actionType to video
  var actionType = "vi";

  var CloudAppBackgroundRecordJs = function () {
    this.init();
  };

  /**
   * Initialize.
   */
  CloudAppBackgroundRecordJs.prototype.init = function() {};

  /**
   * Routine to run onMessage events.
   */
  CloudAppBackgroundRecordJs.prototype.onMessage = function( request, sender ) {
    currentTabId = sender.tab.id;
    switch ( request.type ) {

      case 'CloudAppLaunchRecorder' :
        currentConfig = request.config;
        chrome.storage.sync.set( currentConfig, function() {});
        break;

      case 'CloudAppStopRecord':
        currentConfig = request.config;
        chrome.storage.sync.set( currentConfig, function() {
          _iconDefault();
          _saveRecording();
          // Analytics.
          SegmentApi.track('Stop_Recording');
        });
        break;

      case 'CloudAppStartRecord':
        currentConfig = request.config;
        chrome.storage.sync.set( currentConfig, function() {
          _recordMainStream();
        });
        break;

      case 'CloudAppPauseRecord':
        currentConfig = request.config;
        chrome.storage.sync.set( currentConfig, function() {});
        if ( recorder ) {
          recorder.pauseRecording();
          _iconIsPaused();
        }
        break;

      case 'CloudAppResumeRecord':
        currentConfig = request.config;
        chrome.storage.sync.set( currentConfig, function() {});
        if ( recorder ) {
          if ( currentConfig.mediaSourceTab == 'video-stream-desktop' ) {
            setTimeout(function() {
              recorder.startRecording();
              _iconIsRecording();
            }, 1000);
          }
          else {
            recorder.resumeRecording();
          }
        }
        break;

      case 'CloudAppStartCountdown':
        currentConfig = request.config;
        chrome.storage.sync.set( currentConfig, function() {});
        break;

      case 'CloudAppCancelRecording':
        currentConfig = request.config;
        chrome.storage.sync.set( currentConfig, function() {});
        _clearAllStreams();
        _iconDefault();
        break;

      case 'CloudAppRequest_Desktop':
        currentConfig = request.config;
        chrome.storage.sync.set( currentConfig, function() {});
        _recordDesktop();
        break;
    }
  };

  /**
   * When current tab updated (link clicked etc..) we re-launch record controls on current tab refresh.
   */
  CloudAppBackgroundRecordJs.prototype.onTabUpdated = function( tabId, changeInfo, tab ) {
    // Make sure if user is recording to bring recording controls back on page refresh.
    if ( changeInfo.status == 'complete' && tabId == currentTabId && currentConfig !== undefined ) {
      if ( currentConfig.isRecording !== undefined ) {
        if ( currentConfig.isRecording === true ) {
          chrome.tabs.sendMessage( tabId, { type: 'showCloudAppRecorder', config: currentConfig });
        }
      }
    }
  };

  /**
   * Keyboard shorcuts.
   */
  CloudAppBackgroundRecordJs.prototype.keyboardShortcuts = function( command ) {
    if ( command === 'cloudapp-record-screen' ) {
      _sendMsgCurrentTab(function( tabId ) {
        chrome.tabs.sendMessage( tabId, { type: 'openCloudAppRecord' });
      });
    }
  };

  /**
   * Record current browser tab.
   */
  function _recordMainStream() {
    if (currentConfig.mediaTypeTab == 'tab-camonly') {
      _recordWebcam();
    }
    else {
      if (currentConfig.mediaSourceTab == 'video-stream-tab') {
        _recordCurrentTab();
      }
    }
    // Analytics.
    SegmentApi.track('Start_Recording');
  };

  function _recordWebcam() {
    actionType = "ca";
    var webcamConstraints = { video: true };
    if ( currentConfig.defaultCamDevice_id != 'default' ) {
      webcamConstraints = { video: { deviceId: (currentConfig.defaultCamDevice_id) ? { exact: currentConfig.defaultCamDevice_id } : undefined } };
    }

    // Stream webcam from a user selected device
    _getUserMediaStream( webcamConstraints , function( stream ) {
      if ( stream ) {
        _iconIsRecording();
        // Making sure we're saving screen stream in global variable so it can be stopped when needed.
        screenStream = stream;
        _processStream( stream );
      }
    },
    function ( err ) {
      console.log( err );
    });
  };

  function _recordDesktop() {
    actionType = "vi";
    chrome.desktopCapture.chooseDesktopMedia( [ 'screen', 'window' ], function( desktop_id ) {
      if ( desktop_id ) {

        var desktopConstraints = {
          audio: false,
          video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: desktop_id, maxWidth: 4000, maxHeight: 4000 } }
        };

        // Stream webcam from a user selected device
        _getUserMediaStream( desktopConstraints , function( stream ) {
          if ( stream ) {
            // Making sure we're saving screen stream in global variable so it can be stopped when needed.
            screenStream = stream;
            _processStream( stream );
            _iconDefault();
            _sendMsgCurrentTab(function( tabId ) {
              chrome.tabs.sendMessage( tabId, { type: 'showCloudAppRecordCountdown_Desktop', config: currentConfig });
            });
          }
        },
        function ( err ) {
          console.log( err );
        });

      }
      else {
        _clearAllStreams();
        _iconDefault();
        _sendMsgCurrentTab(function( tabId ) {
          var currentTabId = tabId;
          chrome.tabs.sendMessage( currentTabId, { type: 'hideCloudAppRecorder', config: currentConfig }, function( response ) {
            parent.postMessage( 'closeCloudApp', '*' );
          });
        });
      }
    });
    // Analytics.
    SegmentApi.track('Start_Recording');
  };

  function _recordCurrentTab() {
    actionType = "vi";
    chrome.tabs.query({
      active: true,
      currentWindow: true
    },
    function( tabs ) {

      var constraints = {
        audio: false,
        video: true,
        videoConstraints: {
          mandatory: {
            chromeMediaSource: 'tab',
            maxWidth: 3840,
            maxHeight: 2160
          }
        }
      };

      chrome.tabCapture.capture( constraints, function( stream ) {
        if ( stream ) {
          _iconIsRecording();
          // Making sure we're saving screen stream in global variable so it can be stopped when needed.
          screenStream = stream;
          _processStream( stream );
        }
      });

    });
  };

  /**
   * Process video and audio stream.
   */
  function _processStream( stream ) {

    // Merge audio and video streams
    if ( currentConfig.audioDeviceEnabled ) {

      // This is where we get users audio (mic)
      var micConstraints = true;

      // Make sure to use user selected audio device.
      if ( currentConfig.defaultMicDevice_id !== undefined ) {
        micConstraints = {
          mandatory: {
            echoCancellation: true
          },
          optional: [{
            sourceId: (currentConfig.defaultMicDevice_id != 'default') ? currentConfig.defaultMicDevice_id : undefined
          }]
        };
      }

      _getUserMediaStream( { audio: micConstraints } , function( stream, devices ) {
        // Making sure we're saving audio stream in global variable so it can be stopped when needed.
        micStream = stream;
        var audio = document.createElement( 'audio' );
        audio.srcObject = micStream;
        audio.muted = true;
        audio.play();

        // Merging two streams (mic and screen)
        var combinedMicScreenStream = new MediaStream();
        [ micStream, screenStream ].forEach(function( s ) {
          s.getTracks().forEach(function( t ) {
            combinedMicScreenStream.addTrack( t );
          });
        });

        recorder = new RecordRTC( combinedMicScreenStream, {
          disableLogs: true,
          type: 'video',
          mimeType : mimeType
        });

        if ( currentConfig.mediaSourceTab != 'video-stream-desktop' ) {
          // Start stream recording.
          recorder.startRecording();
        }
      },
      function ( err ) {
        console.log( err );
      });

    }
    else {

      recorder = new RecordRTC( screenStream, {
        disableLogs: true,
        type: 'video',
        mimeType : mimeType
      });

      if ( currentConfig.mediaSourceTab != 'video-stream-desktop' ) {
        // Start stream recording.
        recorder.startRecording();
      }
    }

    // We need this when we click 'Stop sharing' desktop button
    // or when browser tab closed.
    screenStream.getVideoTracks()[ 0 ].onended = function () {
      _iconDefault();
      _saveRecording();
    };

  };

  /**
   * Check if browser supports media and trigger media usage premission prompt.
   */
  function _getUserMediaStream( constraints, successCallback, failedCallback ) {
    if ( !navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices ) {
      failedCallback( 'enumerateDevices() not supported.' );
    }
    if ( navigator.getUserMedia ) {
      navigator.getUserMedia( constraints,
        // Success Callback
        function( stream ) {
          // We need this so we can stop streaming as we change settings.
          if ( constraints.audio ) {
            micStream =  stream.getTracks()[0];
          }
          var deviceStream = stream;
          navigator.mediaDevices.enumerateDevices().then(function( devices ) {
            successCallback( deviceStream, devices );
          })
          .catch(function( err ) {
            failedCallback( err.name + ': ' + err.message );
          });
        },
        // Error Callback
        function( err ) {
          failedCallback( 'The following error occurred when trying to use getUserMedia: ' + err );
        }
      );
    }
    else {
      failedCallback( 'getUserMedia() not supported.' );
    }
  };

  /**
   * Clear (stop) all streams.
   */
  function _clearAllStreams() {
    // Stop all streaming.
    if ( screenStream ) {
      screenStream.getTracks().forEach(function( track ) {
        track.stop();
      });
      screenStream = null;
    }
    if ( micStream ) {
      micStream.getTracks().forEach(function( track ) {
        track.stop();
      });
      micStream = null;
    }
  };

  /**
   * Stream routine (capture, save and redirect to editor).
   */
  function _saveRecording() {
    if ( recorder ) {

      if ( currentConfig.defaultVideoFormat !== undefined ) {
        if (currentConfig.defaultVideoFormat == 'webm') {
          mimeType = 'video/webm;codecs=vp9';
          ext = 'webm';
        }
      }

      recorder.stopRecording(function() {
        chrome.storage.sync.set( { 'isRecording': false } );

        var blob = recorder.getBlob();

        // Generate screen recording filename.
        var dateTimeStamp = new Date().toISOString();
        var filename =  'Screen-Recording-' + dateTimeStamp + '.' + ext;

        // Callback when screen recording ended.
        function onWriteEnd() {
          chrome.storage.sync.get( [ 'token' ] , function( config ) {

            chrome.tabs.query({ active: true, currentWindow: true }, function( tabs ) {
              chrome.tabs.sendMessage( tabs[0].id, { 'type': 'openCloudAppDashboard' });
            });

            CloudAppApi.setFileBlob( blob );
            CloudAppApi.setFileName( filename );
            var res = CloudAppApi.upload(
              config.token,
              function ( response ) {
                // Open a new tab as soon as we get the slug.
                if ( response.slug != null ) {
                  chrome.tabs.query({ active: true, currentWindow: true }, function( tabs ) {
                    chrome.tabs.sendMessage( tabs[0].id, { 'type': 'uploadProgressComplete' });
                  });
                  chrome.tabs.create( { url: dropUrlBase + response.slug } );
                }
                else {
                  _createNotification( 'failure', null, 'Video uploaded but the app failed to redirect. Please refresh page and try again.' );
                }
              },
              function( response ) {
                // Upload successfully complete.
                _createNotification( 'Upload Complete!', 'success', response);
              },
              function( message ) {
                // Could not upload the file.
                _createNotification( 'Upload Failed', 'failure', null, 'Upload failed, please give another try' );
              },
              function( total, loaded, drop ) {
                var progressPercentage = Math.floor((loaded / total) * 100);
                chrome.tabs.query({ active: true, currentWindow: true }, function( tabs ) {
                  chrome.tabs.sendMessage( tabs[0].id, { 'type': 'uploadProgress', 'percentage': progressPercentage, 'filename': filename, 'drop': drop });
                });
              },
              mimeType,
              actionType
            );
          });
        }

        // Error message callback.
        function errorHandler() {
          console.log( 'Something went wrong. Could not save recording.' );
        }

        // Create a blob for writing to a file.
        window.webkitRequestFileSystem( TEMPORARY, 1024 * 1024, function( fs ) {
          fs.root.getFile( filename, { create: true }, function( fileEntry ) {
            fileEntry.createWriter(function( fileWriter ) {
              fileWriter.onwriteend = onWriteEnd;
              fileWriter.write( blob );
            }, errorHandler );
          }, errorHandler );
        }, errorHandler );

        _clearAllStreams();

      });
    }
  };

  // Show OS notification.
  function _createNotification( title, type, response, message ) {
    var linkMap = {};
    var notificationId = 'cloudappBgScreenshot_' + Math.random();
    var dropUrl = ( response != null && response.slug != null ) ? dropUrlBase + response.slug : null;
    // Copy drop URL to clipboard.
    if ( dropUrl !== null ) {
      copyToClipboard( dropUrl );
    }
    chrome.notifications.create( notificationId, {
        type: 'basic',
        iconUrl: (type == 'success') ? chrome.runtime.getURL( 'assets/img/icons/success_48.png' ) : chrome.runtime.getURL( 'assets/img/icons/error_48.png' ),
        title: title,
        message: (type == 'success') ? 'The sharing URL is copied to your clipboard' : message
      },
      function() {
        linkMap[ notificationId ] = dropUrl;
      }
    );
    // Open in a new tab
    if ( dropUrl !== null ) {
      // chrome.tabs.create( { url: dropUrl } );
    }
    // Make notification clickable and take a user to the uploaded capture.
    chrome.notifications.onClicked.addListener(function( notificationId ) {
      var dropUrl = ( linkMap[ notificationId ] !== null || linkMap[ notificationId ] !== "undefined" ) ? linkMap[ notificationId ] : null;
      if ( dropUrl !== null ) {
        var isValidURL = dropUrl.match(/(http(s)?:\/\/.)?(www\.)?[-a-zA-Z0-9@:%._\+~#=]{2,256}\.[a-z]{2,6}\b([-a-zA-Z0-9@:%_\+.~#?&//=]*)/g);
        if (isValidURL !== null) {
          chrome.tabs.create({url: linkMap[ notificationId ]});
        }
      }
    });
  };

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
      return clipboardData.setData('Text', text);
    }
    else if (document.queryCommandSupported && document.queryCommandSupported('copy')) {
      var textarea = document.createElement('textarea');
      textarea.textContent = text;
      textarea.style.position = "fixed";  // Prevent scrolling to bottom of page in MS Edge.
      document.body.appendChild(textarea);
      textarea.select();
      try {
        return document.execCommand('copy');  // Security exception may be thrown by some browsers.
      }
      catch (ex) {
        console.warn('Copy to clipboard failed.', ex);
        return false;
      }
      finally {
        document.body.removeChild(textarea);
      }
    }
  };

  /**
   * Animate app icon when recording is in progress.
   */
  function _iconIsRecording() {
    if ( currentConfig.isRecording !== undefined ) {
      if ( currentConfig.isRecording === true ) {
        chrome.browserAction.setIcon( { path: 'assets/img/icons/rec/' + current + '.png', tabId: currentTabId } );
        if ( current++ > max ) {
          current = min;
        }
        window.setTimeout( _iconIsRecording, 150 );
      }
    }
    else {
      clearTimeout( _iconIsRecording );
    }
  };

  /**
   * Animate app icon when recording is in progress.
   */
  function _iconIsPaused() {
    clearTimeout( _iconIsRecording );
    chrome.browserAction.setIcon( { path: 'assets/img/icons/rec/6.png', tabId: currentTabId } );
  };

  /**
   * Animate app icon when recording is in progress.
   */
  function _iconDefault() {
    clearTimeout( _iconIsRecording );
    chrome.browserAction.setIcon( { path: 'assets/img/icons/icon_16.png', tabId: currentTabId } );
  };

  /**
   * Send message to current tab.
   */
  function _sendMsgCurrentTab( successCallback ) {
    chrome.tabs.query( { active: true, currentWindow: true }, function( tabs ) {
      successCallback( tabs[ 0 ].id );
    });
  };

  return CloudAppBackgroundRecordJs;

}));

var bgRecordJs = new CloudAppBackgroundRecordJs();

/**
 * Make sure the app is listening to messages in the current tab.
 */
chrome.runtime.onMessage.addListener(function( request, sender, sendResponse ) {
  if ( request.type !== "undefined" ) {
    bgRecordJs.onMessage( request, sender );
  }
  sendResponse({});
});

/**
 * Listen to shortcut commands.
 */
chrome.commands.onCommand.addListener(function( command ) {
  bgRecordJs.keyboardShortcuts( command );
});

/**
 * Listen to tab content updates.
 */
chrome.tabs.onUpdated.addListener( function ( tabId, changeInfo, tab ) {
  bgRecordJs.onTabUpdated( tabId, changeInfo, tab );
});

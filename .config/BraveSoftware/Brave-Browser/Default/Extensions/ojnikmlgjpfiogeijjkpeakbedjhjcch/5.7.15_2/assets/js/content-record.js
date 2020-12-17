/**
 * Content (record) script.
 */

(function( root, factory ) {
  if ( typeof define === 'function' && define.amd ) {
    define( factory );
  } else if ( typeof exports === 'object' ) {
    module.exports = factory();
  } else {
    root.CloudAppContentRecordJs = factory();
  }
}( this, function() {

  "use strict";

  var currentConfig;
  var countDownSeconds = 4;

  var startRecordingTimer;

  var CloudAppContentRecordJs = function ( request ) {
    this.init( request  );
  };

  /**
   * Initialize.
   */
  CloudAppContentRecordJs.prototype.init = function( request ) {
    switch ( request.type ) {

      case 'launchCloudApp':
      case 'hideCloudAppRecorder':
        _cancelRecordingAction();
        break;

      case 'showCloudAppRecorder':
        currentConfig = request.config;
        _showRecordControls();
        break;

      case 'showCloudAppRecordCountdown':
        currentConfig = request.config;
        currentConfig.isRecording = true;
        _showRecordControls();
        _startCountdown(function() {
          chrome.runtime.sendMessage( { type: 'CloudAppStartRecord', config: currentConfig });
        });
        break;

      case 'showCloudAppRecordRequest_Desktop':
        currentConfig = request.config;
        currentConfig.isRecording = true;
        chrome.runtime.sendMessage( { type: 'CloudAppRequest_Desktop', config: currentConfig });
        break;

      case 'showCloudAppRecordCountdown_Desktop':
        currentConfig = request.config;
        _showRecordControls();
        _startCountdown(function() {
          chrome.runtime.sendMessage( { type: 'CloudAppResumeRecord', config: currentConfig });
        });
        break;
    }
  };

  /**
   * Record controls.
   */
  function _showRecordControls() {
    var webcamIframe = '';
    var noCamIcon = '<ca-noaction class="cloudapp-btn ca-cam-off"><img class="ca-trggr-ctr" src="' + chrome.runtime.getURL( 'assets/img/rec-cam-off.png' ) + '" border="0"></ca-noaction>';
    var noMicIcon = '<ca-noaction class="cloudapp-btn ca-mic-off"><img class="ca-trggr-ctr" src="' + chrome.runtime.getURL( 'assets/img/rec-mic-off.png' ) + '" border="0"></ca-noaction>';
    var webcamMicBadge = '<ca-micbadge class="ca-webcam-mic-badge"><img src="' + chrome.runtime.getURL( 'assets/img/rec-no-mic-badge.png' ) + '" border="0"></ca-micbadge>';
    if ( currentConfig.audioDeviceEnabled ) {
      if ( currentConfig.webcamDeviceEnabled ) {
        noMicIcon = '';
        webcamMicBadge = '';
      }
      else {
        noMicIcon = '<ca-noaction class="cloudapp-btn ca-mic-on"><img class="ca-trggr-ctr" src="' + chrome.runtime.getURL( 'assets/img/rec-mic-on.png' ) + '" border="0"></ca-noaction>';
      }
    }

    if ( currentConfig.webcamDeviceEnabled ) {
      noCamIcon = '';
      noMicIcon = '';
      webcamIframe = webcamMicBadge + '<ca-webcam class="cloudapp-webcam-container default"><iframe id="cloudapp-webcam" src="' + chrome.runtime.getURL( 'assets/webcam.html' ) + '" allow="microphone; camera" style="border: none" frameBorder="0"></iframe></ca-webcam>';
    }

    var controls = document.getElementById( 'cloudapp-controls' );
    if ( controls !== null ) {
      controls.parentNode.removeChild( controls );
    }
    var controls = document.createElement( 'cloudapp-container' );
    controls.setAttribute( 'id', 'cloudapp-controls' );
    controls.innerHTML = '<cloudapp-container id="cloudapp-controls"><cloudapp-container id="cloudapp-controls"><div class="ca-recording-controls-overlay ca-reveal-effect"><div class="ca-countdown-overlay ca-el-hidden"><div class="ca-countdown-value"></div></div><div class="ca-recording-controls ca-reveal-effect">' + webcamIframe + '<div class="ca-control-buttons-wrapper"><div class="ca-control-buttons-pos nocam"><div class="ca-control-buttons-inner"><ca-group class="ca-trggr-rec-group ca-el-hidden"><ca-group-item class="ca-group-item ca-rec-toggle"><ca-pause class="ca-group-btn ca-trggr-pause"><img class="ca-trggr-ctr" src="' + chrome.runtime.getURL( 'assets/img/rec-btn-pause.png' ) + '" border="0"></ca-pause><ca-resume class="ca-group-btn ca-trggr-resume"><img class="ca-trggr-ctr" src="' + chrome.runtime.getURL( 'assets/img/rec-btn-rec.png' ) + '" border="0"></ca-resume></ca-group-item><ca-group-item class="ca-group-item ca-rec-cancel"><ca-cancel class="ca-group-btn ca-trggr-cancel"><img class="ca-trggr-ctr" src="' + chrome.runtime.getURL( 'assets/img/rec-btn-cancel.png' ) + '" border="0"></ca-cancel></ca-group-item><ca-group-item class="ca-group-item ca-rec-done"><ca-done class="ca-group-btn ca-trggr-done"><img class="ca-trggr-ctr" src="' + chrome.runtime.getURL( 'assets/img/rec-btn-done.png' ) + '" style="height:29px;width:100%;" border="0"></ca-done></ca-group-item></ca-group><ca-group class="ca-trggr-default-group"><ca-rec class="cloudapp-btn ca-trggr-visible ca-trggr-rec"><img class="ca-trggr-ctr" src="' + chrome.runtime.getURL( 'assets/img/rec-btn-rec.png' ) + '" border="0"></ca-rec><ca-cancel class="cloudapp-btn ca-trggr-visible ca-trggr-cancel"><img class="ca-trggr-ctr" src="' + chrome.runtime.getURL( 'assets/img/rec-btn-cancel.png' ) + '" border="0"></ca-cancel></ca-group></div></div></div></div></div></cloudapp-container></cloudapp-container>';
    // Place iframe immediately after the opening <body> tag
    document.documentElement.appendChild( controls );

    var btnRecGroup = document.querySelector('#cloudapp-controls .ca-trggr-rec-group');
    var btnDefaultGroup = document.querySelector('#cloudapp-controls .ca-trggr-default-group');
    var btnPause = document.querySelector('#cloudapp-controls .ca-trggr-pause');
    var btnResume = document.querySelector('#cloudapp-controls .ca-trggr-resume');
    var btnDone = document.querySelector('#cloudapp-controls .ca-group-btn.ca-trggr-done');

    if ( currentConfig.isRecording ) {
      btnRecGroup.classList.remove('ca-el-hidden');
      btnRecGroup.classList.add('ca-el-expand');
      btnDefaultGroup.classList.add('ca-el-hidden');
      btnPause.classList.remove('ca-el-hidden');
      btnResume.classList.add('ca-el-hidden');
    }

    // Start recording.
    document.querySelector('#cloudapp-controls .cloudapp-btn.ca-trggr-rec').addEventListener( 'click', function( e ) {
      
      btnRecGroup.classList.remove('ca-el-hidden');
      btnRecGroup.classList.add('ca-el-expand');
      btnDefaultGroup.classList.add('ca-el-hidden');
      btnPause.classList.remove('ca-el-hidden');
      btnResume.classList.add('ca-el-hidden');

      currentConfig.isPaused = false;
      currentConfig.isResumed = false;
      // Make sure we close all app views
      window.postMessage( 'closeCloudApp', '*' );
      currentConfig.isRecording = true;
      _startCountdown(function() {
        chrome.runtime.sendMessage( { type: 'CloudAppStartRecord', config: currentConfig });
      });
    });

    // Pause recording.
    btnPause.addEventListener( 'click', function( e ) {
      btnPause.classList.add('ca-el-hidden');
      btnResume.classList.remove('ca-el-hidden');

      currentConfig.isPaused = true;
      currentConfig.isResumed = false;
      chrome.runtime.sendMessage( { type: 'CloudAppPauseRecord', config: currentConfig });
    });

    // Resume recording.
    btnResume.addEventListener( 'click', function( e ) {
      btnPause.classList.remove('ca-el-hidden');
      btnResume.classList.add('ca-el-hidden');

      currentConfig.isPaused = false;
      currentConfig.isResumed = true;
      chrome.runtime.sendMessage( { type: 'CloudAppResumeRecord', config: currentConfig });
    });

    // Cancel recording.
    var cancelButtons = document.querySelectorAll( '#cloudapp-controls .ca-group-btn.ca-trggr-cancel, #cloudapp-controls .cloudapp-btn.ca-trggr-cancel' );
    for ( var i = 0; i < cancelButtons.length; i++ ) {
      cancelButtons[i].addEventListener( 'click' , function() {
        // Make sure to reset time lapsed back to 1 second.
        window.postMessage( 'closeCloudApp', '*' );
        if ( confirm( 'Are you sure you want to cancel your recording?' ) ) {
          _cancelRecordingAction();
        }
      });
    }

    // Done recording.
    btnDone.addEventListener( 'click', function( e ) {
      if ( currentConfig.isRecording ) {
        currentConfig.isRecording = false;
        // Make sure to reset time lapsed back to 1 second.
        _cancelRecordingAction();
        chrome.runtime.sendMessage( { type: 'CloudAppStopRecord', config: currentConfig });
      }
    });

  };

  /**
   * Record countdown.
   */
  function _startCountdown( successCallback ) {
    var countDownValElement = document.querySelector('#cloudapp-controls .ca-countdown-overlay .ca-countdown-value');
    var countDownOverlay = document.querySelector('#cloudapp-controls .ca-countdown-overlay');
    if ( countDownOverlay !== null ) {
      countDownOverlay.classList.remove('ca-el-hidden');
      var secondsLapsed = countDownSeconds;
      // Start recording when timer is over.
      startRecordingTimer = setInterval(function() {
        secondsLapsed--;
        // We actually wait for 4 seconds, but countdown should be visible starting with 3
        if ( secondsLapsed < countDownSeconds ) {
          countDownValElement.innerHTML = secondsLapsed;
        }
        if ( !currentConfig.isRecording ) {
          clearInterval( startRecordingTimer );
        }
        if ( secondsLapsed <= 0 && currentConfig.isRecording ) {
          successCallback();

          countDownOverlay.classList.add('ca-el-hidden');
          clearInterval( startRecordingTimer );
        }
      }, 1000);
    }
  };

  /**
   * Close record controls and stop recording.
   */
  function _cancelRecordingAction() {
    var controls = document.getElementById( 'cloudapp-controls' );
    if ( controls !== null ) {
      currentConfig.isRecording = false;
      chrome.runtime.sendMessage( { type: 'CloudAppCancelRecording', config: currentConfig }, function() {
        controls.parentNode.removeChild( controls );
      });
    }
  };

  return CloudAppContentRecordJs;

}));

// Listen to messages sent from various components of the extension.
chrome.runtime.onMessage.addListener(function( request, sender, sendResponse ) {
  if ( request.type !== undefined  ) {
    new CloudAppContentRecordJs( request );
    sendResponse({});
  }
});

/**
 * Webcam script (iframe code).
 */

(function( root, factory ) {
  if ( typeof define === 'function' && define.amd ) {
    define( factory );
  } else if ( typeof exports === 'object' ) {
    module.exports = factory();
  } else {
    root.WebcamView = factory();
  }
}( this, function() {

  "use strict";

  var body = document.body;

  var WebcamView = function () {
    this.init();
  };

  /**
   * Initialize.
   */
  WebcamView.prototype.init = function() {
    chrome.storage.sync.get( [ 'isRecording', 'webcamDeviceEnabled', 'defaultCamDevice_id' ] , function( config ) {
      // This is where we get users webcam
      if ( config.webcamDeviceEnabled ) {
        
        var webcamConstraints = { video: true };
        if ( config.defaultCamDevice_id != 'default' ) {
          webcamConstraints = { video: { deviceId: (config.defaultCamDevice_id) ? { exact: config.defaultCamDevice_id } : undefined } };
        }

        // Stream webcam from a user selected device
        _getCamStream( webcamConstraints , function( stream ) {
          var cam = document.getElementById( 'cloudapp-webcam' );
          cam.srcObject = stream;
        },
        function ( err ) {
          console.log( err );
        }); 
      }
    });
  };

  /**
   * Check if browser supports media and trigger media usage premission prompt.
   */
  function _getCamStream( constraints, successCallback, failedCallback ) {
    if ( !navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices ) {
      failedCallback( 'enumerateDevices() not supported.' );
    }
    if ( navigator.getUserMedia ) {
      navigator.getUserMedia( constraints,
        // Success Callback
        function( stream ) {
          var deviceStream = stream;
          navigator.mediaDevices.enumerateDevices().then(function( devices ) {
            successCallback( deviceStream );
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

  return WebcamView;

}));

new WebcamView();

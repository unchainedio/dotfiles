/**
 * Record script (iframe code).
 * @TODO: The code is really ugly, need to make some refinements to make it look better
 *        and refine settings form. Build/use maybe some kind of UI library?
 */

(function( root, factory ) {
  if ( typeof define === 'function' && define.amd ) {
    define( factory );
  } else if ( typeof exports === 'object' ) {
    module.exports = factory();
  } else {
    root.RecordView = factory();
  }
}( this, function() {

  "use strict";

  var body = document.body;

  var webcam_toggle = document.getElementById( 'webcam-device-toggle' );
  var webcam_devices = document.getElementById('cam-devices');
  var audio_toggle = document.getElementById( 'audio-device-toggle' );
  var audio_devices = document.getElementById('mic-devices');
  var video_formats = document.getElementById('video-save-as');

  var camStreamTrack;
  var micStreamTrack;

  var activeDropdown = {};

  var currentConfig = {};
  var currentAudioDeviceIds = [];
  var currentVideoDeviceIds = [];

  var buttonLabels = {
    micOn: 'Audio using',
    micOff: 'Audio is OFF',
    camOn: 'Webcam using',
    camOff: 'Webcam is OFF'
  };

  // Tabs: Source type
  var mediaSourceTabs = document.querySelectorAll('ul.media-source li a');
  // Tabs: Recording type
  var mediaTypeTabs = document.querySelectorAll('ul.media-tabs li a');
  var mediaTypeIcons = {
    'tab-screencam': {
      id: 'tab-screencam-icon',
      inactive: {
        src: chrome.runtime.getURL('assets/img/tabs/icnScreenCamInactive.png'),
        srcset: chrome.runtime.getURL('assets/img/tabs/icnScreenCamInactive.png') + ' 1x, ' + chrome.runtime.getURL('assets/img/tabs/icnScreenCamInactive@2x.png') + ' 2x, ' + chrome.runtime.getURL('assets/img/tabs/icnScreenCamInactive@3x.png') + ' 3x'
      },
      'active': {
        'src': chrome.runtime.getURL('assets/img/tabs/icnScreenCamActive.png'),
        'srcset': chrome.runtime.getURL('assets/img/tabs/icnScreenCamActive.png') + ' 1x, ' + chrome.runtime.getURL('assets/img/tabs/icnScreenCamActive@2x.png') + ' 2x, ' + chrome.runtime.getURL('assets/img/tabs/icnScreenCamActive@3x.png') + ' 3x'
      }
    },
    'tab-screenonly': {
      id: 'tab-screenonly-icon',
      inactive: {
        src: chrome.runtime.getURL('assets/img/tabs/icnScreenInactive.png'),
        srcset: chrome.runtime.getURL('assets/img/tabs/icnScreenInactive.png') + ' 1x, ' + chrome.runtime.getURL('assets/img/tabs/icnScreenInactive@2x.png') + ' 2x, ' + chrome.runtime.getURL('assets/img/tabs/icnScreenInactive@3x.png') + ' 3x'
      },
      active: {
        src: chrome.runtime.getURL('assets/img/tabs/icnScreenActive.png'),
        srcset: chrome.runtime.getURL('assets/img/tabs/icnScreenActive.png') + ' 1x, ' + chrome.runtime.getURL('assets/img/tabs/icnScreenActive@2x.png') + ' 2x, ' + chrome.runtime.getURL('assets/img/tabs/icnScreenActive@3x.png') + ' 3x'
      }
    },
    'tab-camonly': {
      id: 'tab-camonly-icon',
      inactive: {
        src: chrome.runtime.getURL('assets/img/tabs/icnCamInactive.png'),
        srcset: chrome.runtime.getURL('assets/img/tabs/icnCamInactive.png') + ' 1x, ' + chrome.runtime.getURL('assets/img/tabs/icnCamInactive@2x.png') + ' 2x, ' + chrome.runtime.getURL('assets/img/tabs/icnCamInactive@3x.png') + ' 3x'
      },
      active: {
        src: chrome.runtime.getURL('assets/img/tabs/icnCamActive.png'),
        srcset: chrome.runtime.getURL('assets/img/tabs/icnCamActive.png') + ' 1x, ' + chrome.runtime.getURL('assets/img/tabs/icnCamActive@2x.png') + ' 2x, ' + chrome.runtime.getURL('assets/img/tabs/icnCamActive@3x.png') + ' 3x'
      }
    }
  };

  var RecordView = function () {
    this.init();
    this.settings();
    this.shortcuts();
  };

  /**
   * Initialize.
   */
  RecordView.prototype.init = function() {
    // We need this to be able to use keyboard shortcodes.
    window.focus();
    document.activeElement.blur();
  };

  /**
   * Settings routine.
   */
  RecordView.prototype.settings = function() {

    // Toggle advanced settings
    var advancedToggle = document.getElementById('advanced-toggle');
    var advancedShowText = 'Show Advanced Settings';
    advancedToggle.innerHTML = advancedShowText;
    advancedToggle.addEventListener('click', function(e) {
      if ( this.innerHTML == advancedShowText ) { advancedToggle.innerHTML = 'Hide Advanced Settings'; } else { advancedToggle.innerHTML = advancedShowText; }
      document.querySelector('.advanced-options .options-wrapper').classList.toggle('hidden');
    }, false);

    var webcamp_options_wrapper = body.querySelector('.option.webcam');
    var mic_options_wrapper = body.querySelector('.option.audio');

    // Load previously configured settings.
    chrome.storage.sync.get( [ 'webcamDeviceEnabled', 'audioDeviceEnabled', 'defaultMicDevice_id', 'defaultCamDevice_id', 'defaultMicDevice_label', 'defaultCamDevice_label', 'mediaTypeTab', 'mediaSourceTab' ] , function( config ) {

      currentConfig = config;

      if ( currentConfig.mediaTypeTab === undefined ) {
        currentConfig.mediaTypeTab = 'tab-screencam';
      }

      if ( currentConfig.mediaSourceTab === undefined ) {
        currentConfig.mediaSourceTab = 'video-stream-desktop';
      }

      // Webcamera
      if ( currentConfig.webcamDeviceEnabled ) {
        // If webcam option was on start the stream.
        var constraintsVideo = { video: true };
        if ( currentConfig.defaultCamDevice_id ) {
          constraintsVideo = { video: { deviceId: { exact: currentConfig.defaultCamDevice_id } } };
        }
        _requestUserMedia( constraintsVideo );
        webcam_toggle.classList.remove('off');
        webcamp_options_wrapper.querySelector('.label').innerHTML = buttonLabels.camOn;
        webcamp_options_wrapper.querySelector('.device').classList.remove( 'disabled' );
        webcamp_options_wrapper.querySelector('.dropdown-button').innerHTML = (currentConfig.defaultCamDevice_label !== undefined) ? currentConfig.defaultCamDevice_label : 'Default';
      }
      else {
        webcamp_options_wrapper.querySelector('.label').innerHTML = buttonLabels.camOff;
        webcamp_options_wrapper.querySelector('.device').classList.add( 'disabled' );
        webcam_toggle.classList.add('off');
      }
      // Audio
      if ( currentConfig.audioDeviceEnabled ) {
        // If audio option was on start the stream.
        var constraintsAudio = { audio: true };
        if ( currentConfig.defaultMicDevice_id !== undefined ) {
          constraintsAudio = { audio: { deviceId: { exact: currentConfig.defaultMicDevice_id } } };
        }
        _requestUserMedia( constraintsAudio );
        audio_toggle.classList.remove('off');
        mic_options_wrapper.querySelector('.label').innerHTML = buttonLabels.micOn;
        mic_options_wrapper.querySelector('.device').classList.remove( 'disabled' );
        mic_options_wrapper.querySelector('.dropdown-button').innerHTML = (currentConfig.defaultMicDevice_label !== undefined) ? currentConfig.defaultMicDevice_label : 'Default';
      }
      else {

        // If record settings page was never configured.
        if ( currentConfig.audioDeviceEnabled === undefined ) {
          // Use default mic device id when the app is just installed or mic device was never selected
          currentConfig.audioDeviceEnabled = true;
          currentConfig.defaultMicDevice_id = 'default';
          // If audio option was on start the stream.
          var constraintsAudio = { audio: true };
          if ( currentConfig.defaultMicDevice_id != 'default' ) {
            currentConfig.defaultMicDevice_id = defaultMicDevice_id;
            constraintsAudio = { audio: { deviceId: (currentConfig.defaultMicDevice_id) ? { exact: currentConfig.defaultMicDevice_id } : undefined } };
          }
          _requestUserMedia( constraintsAudio );
          mic_options_wrapper.querySelector('.label').innerHTML = buttonLabels.micOn;
          mic_options_wrapper.querySelector('.device').classList.remove( 'disabled' );
          mic_options_wrapper.querySelector('.dropdown-button').innerHTML = (currentConfig.defaultMicDevice_label !== undefined) ? currentConfig.defaultMicDevice_label : 'Default';
        }
        else {
          currentConfig.audioDeviceEnabled = false;
          mic_options_wrapper.querySelector('.label').innerHTML = buttonLabels.micOff;
          mic_options_wrapper.querySelector('.device').classList.add( 'disabled' );
          audio_toggle.classList.add('off');
        }
      }

      Array.from( mediaTypeTabs ).forEach(function( link ) {
        link.addEventListener('click', function( e ) {
          var el = e.target.closest( 'a' );
          if (!el.classList.contains('active')) {
            [].forEach.call( mediaTypeTabs, function( el ) {
              el.classList.remove('active');
              var icon = document.getElementById(mediaTypeIcons[el.id].id);
              icon.setAttribute('src', mediaTypeIcons[el.id].inactive.src);
              icon.setAttribute('srcset', mediaTypeIcons[el.id].inactive.srcset);
            });
            var mediaTypeTabWrapepr = document.querySelector('ul.media-source');
            var icon = document.getElementById(mediaTypeIcons[el.id].id);
            icon.setAttribute('src', mediaTypeIcons[el.id].active.src);
            icon.setAttribute('srcset', mediaTypeIcons[el.id].active.srcset);

            currentConfig.mediaTypeTab = el.id;

            if (el.id == 'tab-screenonly') {
              mediaTypeTabWrapepr.classList.remove('disabled');
              webcamp_options_wrapper.querySelector('.label').innerHTML = buttonLabels.camOff;
              webcamp_options_wrapper.querySelector('.device').classList.add( 'disabled' );
              webcam_toggle.classList.add('off');
              currentConfig.webcamDeviceEnabled = false;
              if ( camStreamTrack ) { camStreamTrack.stop(); }
            }
            else {
              if (el.id == 'tab-camonly') {
                mediaTypeTabWrapepr.classList.add('disabled');
                currentConfig.mediaSourceTab = null;
              }
              else {
                mediaTypeTabWrapepr.classList.remove('disabled');
              }
              webcam_toggle.classList.remove('off');
              // Reset current video devices array.
              currentVideoDeviceIds.splice( 0, currentVideoDeviceIds.length );
              // If webcam option was on start the stream.
              var constraints = { video: true };
              if ( currentConfig.defaultCamDevice_id ) {
                constraints = { video: { deviceId: { exact: currentConfig.defaultCamDevice_id } } };
              }
              _requestUserMedia( constraints );
              webcam_toggle.classList.remove('off');
              webcamp_options_wrapper.querySelector('.label').innerHTML = buttonLabels.camOn;
              webcamp_options_wrapper.querySelector('.device').classList.remove( 'disabled' );
              webcamp_options_wrapper.querySelector('.dropdown-button').innerHTML = (currentConfig.defaultCamDevice_label !== undefined) ? currentConfig.defaultCamDevice_label : 'Default';
              currentConfig.webcamDeviceEnabled = true;
            }

            // Preview recording control when making changes.
            _previewRecordingControls();
            _saveConfig(currentConfig);
            el.classList.add('active');
            e.preventDefault();
          }
        }, false);
      });

      // Tabs: recording stream source
      Array.from( mediaSourceTabs ).forEach(function( link ) {
        link.addEventListener('click', function( e ) {
          var el = e.target.closest( 'a' );
          [].forEach.call( mediaSourceTabs, function( el ) { el.classList.remove('active'); });
          currentConfig.mediaSourceTab = el.id;

          // Preview recording control when making changes.
          _previewRecordingControls();
          el.classList.add('active');
          _saveConfig(currentConfig);
          e.preventDefault();
        }, false);
      });

      // Make sure to show camera preview when record settings view is present.
      _previewRecordingControls();

      // Tabs default settings on view load.
      _triggerClick(document.getElementById(currentConfig.mediaTypeTab));
      _triggerClick(document.getElementById(currentConfig.mediaSourceTab));

      // Toggle web camera.
      webcam_toggle.addEventListener('click', function() {
        chrome.storage.sync.set( { 'webcamDeviceEnabled': webcam_toggle.classList.contains('off') }, function() {
          webcam_toggle.classList.toggle('off');
          if ( !webcam_toggle.classList.contains('off') ) {
            // Reset current video devices array.
            currentVideoDeviceIds.splice( 0, currentVideoDeviceIds.length );
            // Ask permission to use camera and get a list of video devices.
            var constraints = { video: true };
            if ( currentConfig.defaultCamDevice_id ) {
              constraints = { video: { deviceId: { exact: currentConfig.defaultCamDevice_id } } };
            }
            _requestUserMedia( constraints );
            webcamp_options_wrapper.querySelector('.label').innerHTML = buttonLabels.camOn;
            webcamp_options_wrapper.querySelector('.device').classList.remove( 'disabled' );
            webcamp_options_wrapper.querySelector('.dropdown-button').innerHTML = (currentConfig.defaultCamDevice_label !== undefined) ? currentConfig.defaultCamDevice_label : 'Default';
            currentConfig.webcamDeviceEnabled = true;
            // Make sure we switch back to ScreenWebcam view.
            _triggerClick(document.getElementById('tab-screencam'));
            if ( currentConfig.mediaSourceTab === undefined ) {
              currentConfig.mediaSourceTab = 'video-stream-desktop';
            }
          }
          else {
            webcamp_options_wrapper.querySelector('.label').innerHTML = buttonLabels.camOff;
            webcamp_options_wrapper.querySelector('.device').classList.add( 'disabled' );
            currentConfig.webcamDeviceEnabled = false;
            if ( camStreamTrack ) {
              camStreamTrack.stop();
            }
            // Make sure we switch back to ScreenOnly view.
            _triggerClick(document.getElementById('tab-screenonly'));
            if (currentConfig.mediaSourceTab === undefined) {
              currentConfig.mediaSourceTab = 'video-stream-desktop';
            }
          }
          // Preview recording control when making changes.
          _previewRecordingControls();

          if ( chrome.runtime.error ) {
            console.log( 'Could not save wedcamera device status' );
          }

          _saveConfig(currentConfig);
        });
      }, false );

      // Togle microphone.
      audio_toggle.addEventListener('click', function() {
        chrome.storage.sync.set( { 'audioDeviceEnabled': audio_toggle.classList.contains('off') }, function() {
          audio_toggle.classList.toggle('off');
          if ( !audio_toggle.classList.contains('off') ) {
            // Reset current audio devices array.
            currentAudioDeviceIds.splice( 0, currentAudioDeviceIds.length );
            // Ask permission to use camera and get a list of video devices.
            var constraints = { audio: true };
            if ( currentConfig.defaultMicDevice_id ) {
              constraints = { audio: { deviceId: { exact: currentConfig.defaultMicDevice_id } } };
            }
            _requestUserMedia( constraints );
            mic_options_wrapper.querySelector('.label').innerHTML = buttonLabels.micOn;
            mic_options_wrapper.querySelector('.device').classList.remove( 'disabled' );
            mic_options_wrapper.querySelector('.dropdown-button').innerHTML = (currentConfig.defaultMicDevice_label !== undefined) ? currentConfig.defaultMicDevice_label : 'Default';
            currentConfig.audioDeviceEnabled = true;
          }
          else {
            mic_options_wrapper.querySelector('.label').innerHTML = buttonLabels.micOff;
            mic_options_wrapper.querySelector('.device').classList.add( 'disabled' );
            currentConfig.audioDeviceEnabled = false;
            if ( micStreamTrack ) {
              micStreamTrack.stop();
            }
          }

          // Preview recording control when making changes.
          _previewRecordingControls();

          if ( chrome.runtime.error ) {
            console.log( 'Could not save wedcamera device status' );
          }

          _saveConfig(currentConfig);
        });
      }, false );

      // Init device dropdowns.
      webcam_devices.addEventListener( 'click', _initDeviceDropdowns );
      audio_devices.addEventListener( 'click', _initDeviceDropdowns );
      video_formats.addEventListener( 'click', _initDeviceDropdowns );

      // Open Dashboard iframe
      document.getElementById( 'back-to-dashboard' ).addEventListener( 'click', function() {
        currentConfig.isRecording = false;
        _sendMsgCurrentTab(function( tabId ) {
          var currentTabId = tabId;
          chrome.tabs.sendMessage( tabId, { type: 'hideCloudAppRecorder', config: currentConfig }, function( response ) {
            parent.postMessage( 'openCloudAppDashboard', '*' );
          });
        });
      }, false );

      // Open Record iframe
      document.getElementById( 'start-btn' ).addEventListener( 'click', function() {
        // Closing the record view and sending a message to background script to start the recorder.

        if ( currentConfig.mediaSourceTab == 'video-stream-desktop' ) {
          _sendMsgCurrentTab(function( tabId ) {
            chrome.tabs.sendMessage( tabId, { type: 'showCloudAppRecordRequest_Desktop', config: currentConfig }, function( response ) {
              parent.postMessage( 'closeCloudApp', '*' );
            });
          });
        }
        else {
          _sendMsgCurrentTab(function( tabId ) {
            var currentTabId = tabId;
            chrome.tabs.sendMessage( currentTabId, { type: 'showCloudAppRecordCountdown', config: currentConfig }, function( response ) {
              parent.postMessage( 'closeCloudApp', '*' );
            });
          });
        }

      }, false );

    });

  };

  /**
   * Keyboard shortcuts.
   */
  RecordView.prototype.shortcuts = function() {
    // Listen to keyboard events.
    // @see https://css-tricks.com/snippets/javascript/javascript-keycodes/ for more codes.
    body.addEventListener( 'keydown', function( e ) {
      // Close tooltbox.
      if ( e.key == 'Escape' || e.key == 'Esc' || e.keyCode == 27 ) {
        _sendMsgCurrentTab(function( tabId ) {
          var currentTabId = tabId;
          chrome.tabs.sendMessage( currentTabId, { type: 'hideCloudAppRecorder', config: currentConfig }, function( response ) {
            parent.postMessage( 'closeCloudApp', '*' );
          });
        });
      }
    }, true);
  };

  function _saveConfig( config ) {
    chrome.storage.sync.set( config, function() {});
  };

  function _triggerClick(el) {
    if ( el !== null ) { if (typeof el.click == 'function') { el.click(); } else if (typeof el.onclick == 'function') { el.onclick(); } }
  };

  /**
   * Show record controls.
   */
  function _previewRecordingControls() {
    _sendMsgCurrentTab(function( tabId ) {
      var currentTabId = tabId;
      chrome.storage.sync.set( { isRecording: false }, function () {
        chrome.tabs.sendMessage( currentTabId, { type: 'showCloudAppRecorder', config: currentConfig }, function( response ) {});
      });
    });
  };

  /**
   * Initialize custom device dropdown routie.
   */
  function _initDeviceDropdowns( event ) {                                                         
    if ( activeDropdown.id && activeDropdown.id !== event.target.id ) {
      activeDropdown.element.classList.remove('active');
    }
    // Checking if a list element was clicked, changing the inner button value
    if ( event.target.tagName === 'LI' ) {
      activeDropdown.button.innerHTML = event.target.innerHTML;
      for ( var i = 0; i < event.target.parentNode.children.length; i++ ) {
        if ( event.target.parentNode.children[ i ].classList.contains( 'check' ) ) {
          event.target.parentNode.children[ i ].classList.remove( 'check' );
        }
      }
      // Timeout here so the check is only visible after opening the dropdown again
      window.setTimeout(function() {
        _saveDropdownOnChange( event );
        event.target.classList.add( 'check' );
      }, 150);
    }
    for ( var i = 0; i < this.children.length; i++ ) {
      if ( this.children[ i ].classList.contains( 'dropdown-selection' ) ) {
          activeDropdown.id = this.id;
          activeDropdown.element = this.children[ i ];
          this.children[ i ].classList.add( 'active' );
       }
      //adding the dropdown-button to our object
      else if (this.children[ i ].classList.contains( 'dropdown-button' ) ) {
        activeDropdown.button = this.children[ i ];
      }
    }

    window.onclick = function( event ) {
      if ( !event.target.classList.contains( 'dropdown-button' ) ) {
        activeDropdown.element.classList.remove( 'active' );
      }
    }
  };

  /**
   * Saving dropdown device ID on change/select.
   */
  function _saveDropdownOnChange( event ) {
    var deviceTypeName = event.target.getAttribute( 'data-name' );
    var deviceId = event.target.getAttribute( 'data-id' );
    // Save selected audio or video device ID.
    var saveSetting = {};
    saveSetting[ deviceTypeName + '_id' ] = deviceId;
    saveSetting[ deviceTypeName + '_label'] = event.target.getAttribute( 'data-label' );
    chrome.storage.sync.set( saveSetting, function () {

      // Reset current video devices array.
      currentVideoDeviceIds.splice( 0, currentVideoDeviceIds.length );
      currentAudioDeviceIds.splice( 0, currentAudioDeviceIds.length );
      
      if ( deviceTypeName == 'defaultMicDevice' ) {
        if ( micStreamTrack ) {
          micStreamTrack.stop();
        }
        var constraints = { audio: true };
        if ( deviceId ) {
          // Making sure we are globally updating device id.
          currentConfig.defaultMicDevice_id =  deviceId;
          constraints = { audio: { deviceId: { exact: deviceId } } };
        }
      }
      else if ( deviceTypeName == 'defaultVideoFormat' ) {
        currentConfig.defaultVideoFormat = deviceId;
      }
      else {
        if ( camStreamTrack ) {
          camStreamTrack.stop();
        }
        var constraints = { video: true };
        if ( deviceId ) {
          // Making sure we are globally updating device id.
          currentConfig.defaultCamDevice_id =  deviceId;
          constraints = { video: { deviceId: { exact: deviceId } } };
        }
      }
      _requestUserMedia( constraints );

    });
    // Apply preview settings.
    _previewRecordingControls();
  };

  /**
   * Get media devices (with user permission prompt).
   */
  function _requestUserMedia( constraints ) {

    // Reseting device dropdown options.
    var audioOpts = audio_devices.querySelector( '.dropdown-selection' );
    while ( audioOpts.firstChild ) {
      audioOpts.removeChild( audioOpts.firstChild );
    }
    var videoOpts = webcam_devices.querySelector( '.dropdown-selection' );
    while ( videoOpts.firstChild ) {
      videoOpts.removeChild( videoOpts.firstChild );
    }

    // Lets see if browser supports media and what devices are availalbe.
    _getUserDevices( constraints, function( stream, devices ) {
      var audioDevices = 1;
      var webcamDevices = 1;

      devices.forEach(function( device ) {

        var option = document.createElement( 'li' );
        option.setAttribute( 'data-id', device.deviceId );
        if ( device.kind === 'audioinput' ) {
          // Prevent duplicate set of devices in dropdowns.
          if ( currentAudioDeviceIds.indexOf( device.deviceId ) < 0 ) {
            var label = device.label || 'Cam ' + audioDevices;
            option.setAttribute( 'data-name', 'defaultMicDevice' );
            option.setAttribute( 'data-label', label );
            option.innerHTML = label;
            audio_devices.querySelector( '.dropdown-selection' ).appendChild( option );
            audioDevices++;
            currentAudioDeviceIds.push( device.deviceId );
          }
        }
        else if ( device.kind === 'videoinput' ) {
          // Prevent duplicate set of devices in dropdowns.
          if ( currentVideoDeviceIds.indexOf( device.deviceId ) < 0 ) {
            var label = device.label || 'Cam ' + webcamDevices;
            option.setAttribute( 'data-name', 'defaultCamDevice' );
            option.setAttribute( 'data-label', label );
            option.innerHTML = label;
            webcam_devices.querySelector( '.dropdown-selection' ).appendChild( option );
            webcamDevices++;
            currentVideoDeviceIds.push( device.deviceId );
          }
        }

      });
    },
    function ( err ) {
      console.log( err );
    });
  };

  /**
   * Check if browser supports media and trigger media usage premission prompt.
   */
  function _getUserDevices( constraints, successCallback, failedCallback ) {
    if ( !navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices ) {
      failedCallback( 'enumerateDevices() not supported.' );
    }
    if ( navigator.getUserMedia ) {
      navigator.getUserMedia( constraints,
        // Success Callback
        function( stream ) {
          // We need this so we can stop streaming as we change settings.
          if ( constraints.video ) {
            camStreamTrack = stream.getTracks()[0];
          }
          else if ( constraints.audio ) {
            micStreamTrack =  stream.getTracks()[0];
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
   * Send message to current tab.
   */
  function _sendMsgCurrentTab( successCallback ) {
    chrome.tabs.query( { active: true, currentWindow: true }, function( tabs ) {
      successCallback( tabs[ 0 ].id );
    });
  };

  return RecordView;

}));

new RecordView();

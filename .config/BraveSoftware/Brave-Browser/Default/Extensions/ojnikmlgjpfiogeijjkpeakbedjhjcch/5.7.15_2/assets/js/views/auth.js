/**
 * Auth script (iframe code).
 */

(function( root, factory ) {
  if ( typeof define === 'function' && define.amd ) {
    define( factory );
  } else if ( typeof exports === 'object' ) {
    module.exports = factory();
  } else {
    root.AuthView = factory();
  }
}( this, function() {

  "use strict";

  var body = document.body;

  var AuthView = function () {
    this.init();
    this.shortcuts();
  };

  /**
   * Initialize.
   */
  AuthView.prototype.init = function() {

    // We need this to be able to use keyboard shortcodes.
    window.focus();
    document.activeElement.blur();

    document.getElementById( 'google-auth' ).addEventListener( 'click', function() {
      authGoogleOauth();
    });

    document.getElementById( 'cloudapp-auth' ).addEventListener( 'click', function() {
      authCloudApp();
    });

    // Singin on `Enter` keyboard button.
    body.querySelector( '.auth-wrapper').addEventListener( 'keydown', function( e ) {
      if ( e.keyCode == 13 ) {
        document.getElementById( 'cloudapp-auth' ).click();
      }
    }, true);

  };

  /**
   * Keyboard shortcuts.
   */
  AuthView.prototype.shortcuts = function() {
    // Listen to keyboard events.
    // @see https://css-tricks.com/snippets/javascript/javascript-keycodes/ for more codes.
    body.addEventListener( 'keydown', function( e ) {
      if ( e.key == 'Escape' || e.key == 'Esc' || e.keyCode == 27 ) {
        parent.postMessage( 'closeCloudApp', '*' );
      }
    }, true);
  };

  /**
   * Google OAuth.
   */
  function authGoogleOauth() {
    var url = 'https://accounts.google.com/o/oauth2/v2/auth?client_id=%googleClientID%&response_type=token' +
      '&redirect_uri=' + encodeURIComponent('https://share.getcloudapp.com/auth/google_oauth2/callback') +
      '&scope=openid%20profile%20email';

    // Open custom Google OAuth popup.
    chrome.windows.create({
        url: url,
        type: 'popup', width: 500, height: 900,
      },
      function(win) {
        chrome.tabs.onUpdated.addListener(function googleAuthorizationHook(tabId, changeInfo, tab) {
          if (tab.windowId === win.id) {
            var titleParts = tab.title.split(' ', 2);
            var result = titleParts[0];
            if (result.indexOf('#access_token') >= 0) {
              chrome.tabs.onUpdated.removeListener(googleAuthorizationHook);
              chrome.tabs.remove(tabId);
              var result = result.replace('#access_token=', '?t=&token=');
              var _parser = _parseString(result);
              var token = _parser['token'];

              CloudAppApi.googleOauth( token, function( config ) {
                chrome.storage.sync.set( { isLoggedIn: true }, function() {
                  // Analytics.
                  SegmentApi.track('Google_Oauth');
                  // Need few ms to send analytics data.
                  setTimeout(function() {
                    parent.postMessage( 'openCloudAppDashboard', '*' );
                  }, 30);
                  if ( chrome.runtime.error ) {
                    console.log( chrome.runtime.error );
                  }
                });
              },
              function( error ) {
                // Error
                console.log( error );
                _createNotification( 'Doh!', 'Looks like we are experiencing some issues. Please try again or contact support.' );
              });
            }
          }
        });
    });

  };

  /**
   * CloudApp auth.
   */
  function authCloudApp() {

    var email = document.getElementById( 'email' );
    var password = document.getElementById( 'password' );

    CloudAppApi.setCredentials( email.value, password.value );
    CloudAppApi.authenticate(
      // Success authentication.
      function( config ) {
        // Clear error message.
        var errorContainer = body.querySelector( '.error-message');
        errorContainer.remove();
        email.classList.remove('error-input');
        password.classList.remove('error-input');
        // Set the flag that a user is successfully logged in.
        chrome.storage.sync.set( { isLoggedIn: true }, function() {
          // Analytics.
          SegmentApi.track('CloudApp_Auth');
          // Need few ms to send analytics data.
          setTimeout(function() {
            parent.postMessage( 'openCloudAppDashboard', '*' );
          }, 30);

          if ( chrome.runtime.error ) {
            console.log( 'Could not save login status' );
          }
        });
      },
      // Failed authentication.
      function( message, code ) {
        if ( code == 401 ) {
          message = 'Incorrect account information';
        }
        var errorContainer = body.querySelector( '.error-message');
        errorContainer.innerHTML = '<div class="error">' + message + '</div>';
        email.classList.add('error-input');
        password.classList.add('error-input');
        _createNotification( 'Doh!', message );
      }
    );
  };

  // Show OS notification.
  function _createNotification( title, message ) {
    var timer;
    chrome.notifications.create('cloudappError_' + Math.random(), {
        type: 'basic',
        iconUrl: chrome.runtime.getURL( 'assets/img/icons/error_48.png' ),
        title: title,
        message: message
      },
      function( notificationId ) {
        // Clear notification message faster.
        timer = setTimeout(function() { chrome.notifications.clear( notificationId ); }, 2500 );
      }
    );
  };

  /**
   * Parse string into array.
   */
  function _parseString(str) {
    if (typeof str !== 'string') {
      return {};
    }
    str = str.trim().replace(/^(\?|#|&)/, '');
    if (!str) {
      return {};
    }
    return str.split('&').reduce(function (ret, param) {
      var parts = param.replace(/\+/g, ' ').split('=');
      // Firefox (pre 40) decodes `%3D` to `=`
      // https://github.com/sindresorhus/query-string/pull/37
      var key = parts.shift();
      var val = parts.length > 0 ? parts.join('=') : undefined;
      key = decodeURIComponent(key);
      // missing `=` should be `null`:
      // http://w3.org/TR/2012/WD-url-20120524/#collect-url-parameters
      val = val === undefined ? null : decodeURIComponent(val);
      if (!ret.hasOwnProperty(key)) {
        ret[key] = val;
      }
      else if (Array.isArray(ret[key])) {
        ret[key].push(val);
      }
      else {
        ret[key] = [ret[key], val];
      }
      return ret;
    }, {});
  };

  return AuthView;

}));

new AuthView();

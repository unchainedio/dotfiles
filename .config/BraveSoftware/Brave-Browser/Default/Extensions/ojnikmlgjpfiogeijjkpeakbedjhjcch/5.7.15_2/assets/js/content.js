/**
 * Content script.
 *
 * Content scripts are JavaScript files that run in the context of web pages.
 * By using the standard Document Object Model (DOM), they can read details 
 * of the web pages the browser visits, or make changes to them.
 */

(function( root, factory ) {
  if ( typeof define === 'function' && define.amd ) {
    define( factory );
  } else if ( typeof exports === 'object' ) {
    module.exports = factory();
  } else {
    root.CloudAppContentJs = factory();
  }
}( this, function() {

  "use strict";

  var CloudAppContentJs = function ( request ) {
    this.init( request );
    this.events();
  };

  /**
   * Initialize.
   */
  CloudAppContentJs.prototype.init = function( request ) {
    _callAppView( request.type );
    _entirePageCaptureRoutine( request );
  };

  /**
   * Events.
   */
  CloudAppContentJs.prototype.events = function() {

    var eventMethod = window.addEventListener ? 'addEventListener' : 'attachEvent';
    var eventListner = window[ eventMethod ];
    var messageEvent = eventMethod === 'attachEvent' ? 'onmessage' : 'message';

    // Listen for messages coming capture iframe.
    eventListner( messageEvent, function ( e ) {
      _callAppView( e.data );
    });

    // Make sure to close any CloudApp modals when clicked outside the iframe.
    document.body.addEventListener( 'click', function( e ) {
      _closeCloudApp();
    }, false );
  };

  function _callAppView( view ) {
    switch ( view ) {

      case 'launchCloudApp':
        chrome.storage.sync.get( [ 'isLoggedIn' ] , function( config ) {
          if ( config.isLoggedIn && !CloudAppApi.isTokenExpired() ) {
            // Show user dashboard
            _createIframe( 'assets/dashboard.html' );
          }
          else {
            // Initialize auth
            _createIframe( 'assets/auth.html' );
          }
        });
        break;

      case 'openCloudAppCapture':
        _closeCloudApp();
        _createIframe( 'assets/capture.html' );
        break;

      case 'openCloudAppRecord':
        _closeCloudApp();
        _createIframe( 'assets/record.html' );
        break;

      case 'openCloudAppDashboard':
        _closeCloudApp();
        _createIframe( 'assets/dashboard.html' );
        break;

      case 'openCloudAppAuth':
      _closeCloudApp();
      _createIframe( 'assets/auth.html' );
        break;

      case 'openCloudAppFlash':
        _createIframe( 'assets/flash.html' );
        break;

      case 'closeCloudApp':
        _closeCloudApp();
        break;
    }
  };

  function _createIframe( url ) {
    var iframe = document.getElementById( 'cloudapp-iframe' );
    if ( iframe === null ) {
      var iframe = document.createElement( 'iframe' );
      iframe.setAttribute( 'src', chrome.runtime.getURL( url ) );
      iframe.setAttribute( 'id', 'cloudapp-iframe' );
      iframe.frameBorder = 0;
      iframe.style.position = 'fixed';
      iframe.style.top = 0;
      iframe.style.zIndex = '99999999999';
      if ( url == 'assets/auth.html' ) {
        iframe.style.right = 0;
        iframe.style.width = '320px';
        iframe.style.height = '495px';
      }
      else if ( url == 'assets/dashboard.html' ) {
        iframe.style.right = 0;
        iframe.style.width = '400px';
        iframe.style.height = '470px';
      }
      else if ( url == 'assets/capture.html' ) {
        iframe.style.left = 0;
        iframe.style.width = '100%';
        iframe.style.height = '100%';
      }
      else if ( url == 'assets/record.html' ) {
        // Trigger browser to ask for permission to use microphone and camera.
        iframe.setAttribute( 'allow', 'microphone; camera' );
        iframe.style.right = 0;
        iframe.style.width = '430px';
        iframe.style.height = '525px';
      }
      else if ( url == 'assets/flash.html' ) {
        iframe.style.width = '100%';
        iframe.style.height = '100%';
      }
      iframe.style.visibility = 'visible';
      iframe.style.border = 'none';
      iframe.style.background = 'none';
      iframe.style.opacity = 1;
      iframe.style.margin = 0;
      iframe.style.padding = 0;
      // Place iframe immediately after the opening <body> tag
      var s = document.body.firstChild;
      s.parentNode.insertBefore( iframe, s );
    }
    else {
      iframe.parentNode.removeChild( iframe );
    }
  };

  /**
   * Close capture.
   */
  function _closeCloudApp() {
    var iframe = document.getElementById( 'cloudapp-iframe' );
    if ( iframe !== null ) {
      iframe.parentNode.removeChild( iframe );
    }
  };

  /**
   * Scroll back to the top of the page when full page screenshot is done.
   */
  function _resetPage( originalParams ) {
    window.scrollTo( 0, originalParams.scrollTop );
    document.body.style.overflow = originalParams.overflow;

    // Once scrolling is complete we want put elements to their original state ( display: block for now).
    var elems = document.body.getElementsByTagName( '*' );
    for ( var i = 0; i < elems.length; i++ ) {
      if ( window.getComputedStyle( elems[ i ], null ).getPropertyValue('position') == 'fixed' ) {
        elems[ i ].style.display = 'block';
      }
    }
  };

  /**
   * Entire page capture routine that will be running in background.
   * This method recieves message from the parent window and scrolls the page down and back to it is original position.
   */
  function _entirePageCaptureRoutine( request ) {
    // Entire page capture routine.
    switch ( request.msg ) {
      case 'getPageDetails':
        var size = {
          width: Math.max(
            document.documentElement.clientWidth,
            document.body.scrollWidth,
            document.documentElement.scrollWidth,
            document.body.offsetWidth,
            document.documentElement.offsetWidth
          ),
          height: Math.max(
            document.documentElement.clientHeight,
            document.body.scrollHeight,
            document.documentElement.scrollHeight,
            document.body.offsetHeight,
            document.documentElement.offsetHeight
          )
        };

        chrome.extension.sendMessage({
          'msg': 'setPageDetails',
          'size': size,
          'scrollBy': window.innerHeight,
          'originalParams': {
            'overflow': document.body.style.overflow,
            'scrollTop': document.documentElement.scrollTop
          },
          'screenCount': request.screenCount++
        });
        break;

      case 'scrollPage':
        var lastCapture = false;

        window.scrollTo( 0, request.scrollTo );

        // Very first scrolling.
        if ( request.scrollTo === 0 ) {
          document.body.style.overflow = 'hidden';
        }
        else {
          // Making all fixed position elements invisible.
          var elems = document.body.getElementsByTagName( '*' );
          for ( var i = 0; i < elems.length; i++ ) {
            if ( window.getComputedStyle(elems[i], null).getPropertyValue('position') == 'fixed' ) {
              elems[i].style.display = 'none';
            }
          }
        }

        // Last scrolling.
        if ( request.size.height <= window.scrollY + request.scrollBy ) {
          lastCapture = true;
          request.scrollTo = request.size.height - request.scrollBy;
        }

        chrome.extension.sendMessage({
          'msg': 'capturePage',
          'position': request.scrollTo,
          'lastCapture': lastCapture
        });
        break;

      case 'resetPage':
        // This is also where we restore fixed position display properties.
        _resetPage( request.originalParams );
        break;

      case 'showError':
        console.log( 'An internal error occurred while taking a entire page screenshot.' );
        _resetPage( request.originalParams );
        break;
    }
  };

  return CloudAppContentJs;

}));

// Listen to messages sent from various components of the extension.
chrome.extension.onMessage.addListener(function( request, sender, sendResponse ) {
  if ( request.type || request.msg ) {
    new CloudAppContentJs( request );
  }
  sendResponse({});
});

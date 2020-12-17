/**
 * Capture script (iframe code).
 */

(function( root, factory ) {
  if ( typeof define === 'function' && define.amd ) {
    define( factory );
  } else if ( typeof exports === 'object' ) {
    module.exports = factory();
  } else {
    root.CaptureView = factory();
  }
}( this, function() {

  "use strict";

  var body = document.body;
  var doc = document.documentElement;

  // Get current active tab width and height.
  var current_view_width = Math.max( doc.clientWidth, window.innerWidth || 0 );
  var current_view_height = Math.max( doc.clientHeight, window.innerHeight || 0 );

  // Capture controls element.
  var extControls = body.querySelector( '.extension-controls');

  // Capture control buttons.
  var CaptureButtons = [
    {
      id: 'btn-visible-area',
      label: 'Capture visible area',
      hotkeys: '<span class="all-lower">Space</span>',
      msg: {
        type: 'cloudapp-visible-area',
        coords: { x: 0, y: 0, w: current_view_width, h: current_view_height }
      }
    },
    {
      id: 'btn-entire-page',
      label: 'Capture entire page',
      hotkeys: '<span class="all-caps one-char-padding">E</span>',
      msg: {
        type: 'cloudapp-entire-page'
      }
    },
    {
      id: 'btn-desktop',
      label: 'Capture Desktop',
      hotkeys: '<span class="all-caps one-char-padding">D</span>',
      msg: {
        type: 'cloudapp-screenshot-desktop'
      }
    }
  ];

  var CaptureView = function () {
    this.init();
    this.shortcuts();
  };

  /**
   * Initialize.
   */
  CaptureView.prototype.init = function() {

    // We need this to be able to use keyboard shortcodes.
    window.focus();
    document.activeElement.blur();

    for ( var i = 0; i < CaptureButtons.length; i++ ) {

      // Button data object.
      var btn = CaptureButtons[ i ];

      var link = document.createElement( 'a' );
      link.id = btn.id;
      var btn_label = '<div class="label">' + btn.label + '</div>';
      if ( btn.hasOwnProperty( 'hotkeys' ) ) {
        btn_label += '<div class="hotkeys">' + btn.hotkeys + '</div>';
      }
      link.innerHTML = btn_label;
      extControls.appendChild( link );

      // Send a message to execute.
      if ( btn.hasOwnProperty( 'msg' ) ) {
        link.addEventListener( 'click', function( e ) {
          var el = e.target.closest( 'a' );
          var item = _findCaptureButton( CaptureButtons, el.id );
          _takeScreenShot( item.msg );
        }, false );
      }

      // Execute function passed as a parameter.
      if ( btn.hasOwnProperty( 'func' ) ) {
        link.setAttribute( 'data-callback', btn.func );
        link.addEventListener( 'click', function( e ) {
          var el = e.target.closest( 'a' );
          window[ el.getAttribute( 'data-callback' ) ]();
        }, false );
      }

    }

    _initCropper();

  };

  /**
   * Keyboard shortcuts.
   */
  CaptureView.prototype.shortcuts = function() {
    // Listen to keyboard events.
    // @see https://css-tricks.com/snippets/javascript/javascript-keycodes/ for more codes.
    body.addEventListener( 'keydown', function( e ) {
      // Close Capture.
      if ( e.key == 'Escape' || e.key == 'Esc' || e.keyCode == 27 ) {
        _closeCloudApp();
      }
      // Take a screenshot of current visible area.
      else if ( e.keyCode == 32 ) {
        // Space key.
        _takeScreenShot( { type: 'cloudapp-visible-area', coords: { x: 0, y: 0, w: current_view_width, h: current_view_height } } );
      }
      // Take a screenshot of the entire page (top to bottom).
      else if ( e.keyCode == 69 ) {
        // E key.
        _takeScreenShot( { type: 'cloudapp-entire-page' } );
      }
      // Take a desktop screenshot.
      else if ( e.keyCode == 68 ) {
        // D key.
        _takeScreenShot( { type: 'cloudapp-screenshot-desktop' } );
      }
    }, false);
  };

  /**
   * Image cropper routine.
   */
  function _initCropper() {
    var image = new Image();
    image.id = 'croppr';
    image.src = chrome.runtime.getURL( 'assets/img/pixel.png' );

    // We would like to make sure the "fake" image is loaded before we initialize cropping tool.
    image.onload = function() {

      // Naturally hide intro tooltip.
      _initHelpBox( body, false );

      var s = body.firstChild;
      s.parentNode.insertBefore( image, s );

      // Cropper library.
      var crop = new Croppr( image, {
        startSize: [ 0, 0 ],
        onCropStart: function( coords ) {
          var capture = body.querySelector('.extension-capture');
          var cropprRegion = body.querySelector('.croppr-region');
          cropprRegion.style.setProperty("border", "solid 1px #0d0f1a", "important");
          if ( capture ) {
            _initHelpBox( body, true );
            capture.remove();
          }
        },
        onCropEnd: function( coords ) {
          // Crop selected area.
          _takeScreenShot( { type: 'cloudapp-crop', coords: { x: coords.x, y: coords.y, w: coords.width, h: coords.height } } );
        }
      });

      var coords;

      // Show cropping area size next to cropper selector.
      body.addEventListener( 'mousemove', function( e ) {
        coords = crop.getValue();
        if ( coords.width && coords.height ) {
          _cursorSizeIndicator( false );
          // Show width/height of the cropping area.
          document.getElementById( 'cursor-size-info-w' ).innerHTML = coords.width + ' w';
          document.getElementById( 'cursor-size-info-h' ).innerHTML = coords.height + ' h';
        }
      });

      // When overlay clicked we assume user wanted to take a screenshot of the current view.
      body.addEventListener( 'mouseup', function( e ) {
        coords = crop.getValue();
        if ( coords.width === 1 && coords.height === 1 ) {
          _takeScreenShot( { type: 'cloudapp-visible-area', coords: { x: 0, y: 0, w: current_view_width, h: current_view_height } } );
        }
      });
    }
  };

  /**
   * Intro tooltip (help box).
   */
  function _initHelpBox( el, hide ) {

    var speed = 50;
    var _iw = el.querySelector('.intro-wrapper');

    if ( _iw === null ) {
      var _iw = document.createElement( 'div' );
      _iw.className = 'intro-wrapper';
      el.appendChild( _iw );
      var _it = document.createElement( 'div' );
      _it.className = 'intro-tooltip';

      var _div1 = document.createElement( 'div' );
      _div1.className = 'icon-wrapper';
      _div1.innerHTML = '<img src="' + chrome.runtime.getURL( 'assets/img/drag-glyph.png' ) + '" border="0">';
      _it.appendChild( _div1 );

      var _div2 = document.createElement( 'div' );
      _div2.className = 'text-wrapper';
      _div2.innerHTML = '<div class="drag-release">Drag & release</div> <div class="drag-release-help">to capture a region of the screen</div>';
      _it.appendChild( _div2 );

      _iw.appendChild( _it );
    }

    if ( hide ) {
      _iw.remove();
    }

    // Timer routine (hides croping intro after 2 seconds).
    setTimeout(function() {
      var s = _iw.style;
      s.opacity = 1;
      ( function fade() { ( s.opacity -= .1 ) < .1 ? s.display = 'none' : setTimeout( fade, speed ) } )();
    }, 2000);
  };


  /**
   * Show cropping size next to a cursor.
   */
  function _cursorSizeIndicator( hide ) {
    var _container = document.getElementById( 'cursor-size-info' );
    if ( _container === null ) {
      var _container = document.createElement( 'div' );
      _container.id = 'cursor-size-info';
      _container.style.position = 'absolute';
      _container.style.zIndex = 4;
      _container.innerHTML = '<div id="cursor-size-info-w"></div><div id="cursor-size-info-h"></div>';
      body.appendChild( _container );
    }

    if ( hide ) {
      _container.remove();
    }
  };

  /**
   * Send message to background.js to take a screenshot.
   */
  function _takeScreenShot( data ) {
    chrome.runtime.sendMessage( data );
    _closeCloudApp();
  };

  /**
   * Send message from iframe to content.js to close the Capture iframe.
   */
  function _closeCloudApp() {
    parent.postMessage( 'closeCloudApp', '*' );
  };

  /**
   * Find Capture item by ID.
   */
  function _findCaptureButton( haystack, id ) {
    var result  = haystack.filter( function( o ) { return o.id == id; } );
    return result ? result[ 0 ] : null;
  };

  return CaptureView;

}));

/**
 * Get current mouse position and move size indicator.
 */
(function() {
  var mousePos;

  document.onmousemove = handleMouseMove;
  setInterval( getMousePosition, 1 / 100 ); // setInterval repeats every X ms

  function handleMouseMove( ev ) {
    mousePos = {
      x: ev.pageX,
      y: ev.pageY
    };
  }
  function getMousePosition() {
    var pos = mousePos;
    if ( pos ) {
      // Use pos.x and pos.y
      var _container = document.getElementById( 'cursor-size-info' );
      if ( _container !== null ) {
        var offset = 5;
        _container.style.top = pos.y + offset + 'px';
        _container.style.left = pos.x + offset + 'px';
      }
    }
  }
})();

new CaptureView();

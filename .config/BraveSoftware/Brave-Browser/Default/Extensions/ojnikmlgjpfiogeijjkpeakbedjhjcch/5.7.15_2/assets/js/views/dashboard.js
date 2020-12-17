/**
 * Dashboard script (iframe code).
 */

(function( root, factory ) {
  if ( typeof define === 'function' && define.amd ) {
    define( factory );
  } else if ( typeof exports === 'object' ) {
    module.exports = factory();
  } else {
    root.DashboardView = factory();
  }
}( this, function() {

  "use strict";

  var body = document.body;
  var dropsListElement = body.querySelector('.drops');
  var linkMap = {};

  var DashboardView = function () {
    this.init();
    this.shortcuts();
    this.drops();
  };

  /**
   * Initialize.
   */
  DashboardView.prototype.init = function() {

    // We need this to be able to use keyboard shortcodes.
    window.focus();
    document.activeElement.blur();

    // Username from email address.
    chrome.storage.sync.get( [ 'email' ] , function( config ) {
      if ( config.email !== "undefined" ) {
        var email = config.email;
        var name = email.match(/^([^@]*)@/)[1];
        var username = document.getElementById( 'username' );
        username.innerHTML = '<span>' + name + '</span><div class="long-name"></div>';
        // Profile pciture.
        var pic = new Image();
        pic.src = getGravatar( config.email );
        document.getElementById( 'gravatar' ).appendChild( pic );
      }
    });

    // Open Capture iframe
    document.getElementById( 'capture-btn' ).addEventListener( 'click', function() {
      parent.postMessage( 'openCloudAppCapture', '*' );
    }, false );

    // Open Record Settings iframe
    document.getElementById( 'record-btn' ).addEventListener( 'click', function() {
      parent.postMessage( 'openCloudAppRecord', '*' );
    }, false );

    // Logout button
    document.getElementById( 'logout-btn' ).addEventListener( 'click', function() {
      // Analytics.
      SegmentApi.track('Logout');
      CloudAppApi.logout(function() {
        CloudAppApi.resetAll();
        parent.postMessage( 'openCloudAppAuth', '*' );
      });
    }, false );

  };

  /**
   * Keyboard shortcuts.
   */
  DashboardView.prototype.shortcuts = function() {
    // Listen to keyboard events.
    // @see https://css-tricks.com/snippets/javascript/javascript-keycodes/ for more codes.
    body.addEventListener( 'keydown', function( e ) {
      // Close tooltbox.
      if ( e.key == 'Escape' || e.key == 'Esc' || e.keyCode == 27 ) {
        parent.postMessage( 'closeCloudApp', '*' );
      }
    }, true);
  };

  /**
   * Drops.
   */
  DashboardView.prototype.drops = function() {
    var progressStart = false;
    var progressBar;
    var parentNode = body.querySelector( '.drops' );
    var cachedDrops = localStorage['cloudapp.extension.drops'];

    chrome.extension.onMessage.addListener(function( request, sender, sendResponse ) {
      console.log(request.type);
      if ( request.type == 'uploadProgress' ) {
        localStorage['cloudapp.extension.drops'] = '';
        var drop = request.drop;
        drop.name = request.filename;
        drop.thumbnail_url = '';
        drop.created_at = new Date();
        drop.share_url = 'https://share.getcloudapp.com/' + drop.slug;
        if ( !progressStart ) {
          parentNode.insertBefore( dropListItemTemplate( drop, true ), parentNode.firstChild );
          progressBar = parentNode.querySelector( '#progressBar' );
          if ( progressBar !== null ) {
            progressBar.style.display = 'block';
          }
          progressStart = true;
        }
        else {
          if ( request.percentage == 100 ) {
            if ( progressBar !== null ) {
              progressBar.style.display = 'none';
            }
          }
          else {
            var barStatus = parentNode.querySelector( '#barStatus' );
            if ( barStatus !== null ) {
              barStatus.style.width = request.percentage + '%';
            }
          }
        }
      }
      else if ( request.type == 'uploadProgressComplete' ) {
        if ( progressBar !== null ) {
          progressBar.style.display = 'none';
        }
        chrome.storage.sync.get( [ 'token' ] , function( config ) {
          CloudAppApi.getDrops( config.token, 0, function( drops ) {
            cachedDrops = drops;
            localStorage['cloudapp.extension.drops'] = JSON.stringify( cachedDrops );
            buildDropsList( cachedDrops, true );
          },
          function() {
            // Error.
          });
        });
      }

      if ( request.type == 'uploadProgress' || request.type == 'uploadProgressComplete' ) {
        var copyLink = body.querySelectorAll( '.hover-info .action-copy-link' );
        for ( var i = 0; i < copyLink.length; i++ ) {
          if ( !copyLink[i].className.match(/\bprocessed\b/) ) {
            copyLink[i].addEventListener( 'click', function( e ) {
              copyShareURL( e );
            }, false );
            copyLink[i].classList.add( 'processed' );
          }
        }
      }
      sendResponse({});
    });


    if ( typeof cachedDrops == 'undefined' || cachedDrops == '' || cachedDrops == 'undefined') {
      chrome.storage.sync.get( [ 'token' ] , function( config ) {
        CloudAppApi.getDrops( config.token, 0, function( drops ) {
          cachedDrops = drops;
          localStorage['cloudapp.extension.drops'] = JSON.stringify( cachedDrops );
          buildDropsList( cachedDrops, true );
        },
        function() {
          // Error.
        });
      });
    }
    else {
      buildDropsList( JSON.parse( cachedDrops ), true );
    }

    // Infinite scroll functionality.
    var dropsPage = 1;
    // Detect when scrolled to bottom.
    dropsListElement.addEventListener('scroll', function () {
      if ( dropsListElement.scrollTop + dropsListElement.clientHeight >= dropsListElement.scrollHeight ) {

        // More drops loading indicator.
        var loadingMoreDrops = document.createElement('div');
        loadingMoreDrops.id = 'loading-more-drops';
        loadingMoreDrops.innerHTML = '<span>loading more ...</span>';
        dropsListElement.parentNode.insertBefore( loadingMoreDrops, dropsListElement.nextSibling );

        chrome.storage.sync.get( [ 'token' ] , function( config ) {
          CloudAppApi.getDrops( config.token, dropsPage, function( drops ) {
            // Remove loader indicated after elements loaded.
            body.querySelector( '#loading-more-drops' ).remove();
            buildDropsList( drops, false );
            dropsPage++;
          },
          function() {
            // Error.
          });
        });
      }
    });

  };

  /**
   * Build drops.
   */
  function buildDropsList( drops, clear ) {
    if ( clear ) {
      while ( dropsListElement.firstChild ) {
        dropsListElement.removeChild( dropsListElement.firstChild );
      }
    }
    for ( var i = 0; i < drops.length; i++ ) {
      if (drops[i].name != null) {
        dropsListElement.appendChild( dropListItemTemplate( drops[i], false ) );
      }
    }
    var copyLink = body.querySelectorAll( '.hover-info .action-copy-link' );
    for ( var i = 0; i < copyLink.length; i++ ) {
      if ( !copyLink[i].className.match(/\bprocessed\b/) ) {
        copyLink[i].addEventListener( 'click', function( e ) {
          copyShareURL( e );
        }, false );
        copyLink[i].classList.add('processed');
      }
    }
  };

  /**
   * Helper function to copy share URL.
   */
  function copyShareURL( e ) {
    var notificationId = 'cloudappBgScreenshot_' + Math.random();
    var el = e.target.closest( 'a' );
    var dropUrl = el.getAttribute('data-share-url');
    copyToClipboard( dropUrl );
    chrome.notifications.create( notificationId, {
        type: 'basic',
        iconUrl: chrome.runtime.getURL( 'assets/img/icons/icon_48.png' ),
        title: 'Ready to Share',
        message: 'A link to your file is ready to share!'
      },
      function() {
        linkMap[ notificationId ] = dropUrl;
      }
    );
  };

  /**
   * Drop list item template.
   */
  function dropListItemTemplate( drop, isNew ) {
    var dropEl = document.createElement('div');
    var progressBarEl = '';
    dropEl.classList.add('drop');
    dropEl.innerHTML = '<div class="thumbnail' + ( ( isNew && getFilenameExt( drop.name ) == 'mp4' ) ? ' newRecording' : '') + '">' + ( ( isNew && getFilenameExt( drop.name ) == 'mp4' ) ? '<img src="' + chrome.runtime.getURL( 'assets/img/play-ico.png' ) + '" border="0" />' : '<img src="' + drop.thumbnail_url + '" border="0" />') + '</div>'
      + '<div class="info"><div class="name">' + trancateString( drop.name ) + '</div>'
      + ( isNew ? '<div id="progressBar"><div id="barStatus"></div></div>' : '<div class="timestamp">' + getTimeAgo( new Date( drop.created_at ) ) + '</div>' ) + '</div>'
      + '<div class="hover-info">'
        // + ( ( getFilenameExt( drop.name ) !== 'mp4' ) ? '<div class="icon"><a href="' + drop.share_url + '/annotate" class="zoomIn icon-anotate" title="Annotate" target="_blank"><span></span></a></div>' : '' )
        + '<div class="icon action-copy-link"><a href="#" class="zoomIn icon-copylink" title="Copy link" data-share-url="' + drop.share_url + '"><span></span></a></div>'
        + '<div class="icon action-open-link"><a href="' + drop.share_url + '" target="_blank" class="zoomIn icon-openlink" title="Open link"><span></span></a></div>'
      + '</div>';
    return dropEl;
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
      textarea.style.position = 'fixed';  // Prevent scrolling to bottom of page in MS Edge.
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

  function getFilenameExt( filename ) {
    return filename.split('.').pop();
  }

  function getGravatar( email ) {
    if ( email !== '' ) {
      var base = "https://www.gravatar.com/avatar/";
      var hash = md5( email.trim().toLowerCase() );
      return base + hash;
    }
  };

  /**
   * Mac style string trancate.
   */
  function trancateString( str ) {
    if ( str !== undefined && str !== null && str.length > 40 ) {
      return str.substr( 0, 20 ) + '...' + str.substr( str.length - 10, str.length );
    }
    return str;
  };

  /**
   * Time ago based on drop created date time.
   */
  function getTimeAgo( date ) {
    var seconds = Math.floor( (new Date() - date) / 1000 );
    var interval = Math.floor( seconds / 31536000 );
    if ( interval > 1 ) {
      return interval + " years ago";
    }
    interval = Math.floor( seconds / 2592000 );
    if ( interval > 1 ) {
      return interval + " months ago";
    }
    interval = Math.floor( seconds / 86400 );
    if ( interval > 1 ) {
      return interval + " days ago";
    }
    interval = Math.floor( seconds / 3600 );
    if ( interval > 1 ) {
      return interval + " hours ago";
    }
    interval = Math.floor( seconds / 60 );
    if ( interval > 1 ) {
      return interval + " minutes ago";
    }
    return Math.floor( seconds ) + " seconds ago";
  };

  return DashboardView;

}));

new DashboardView();

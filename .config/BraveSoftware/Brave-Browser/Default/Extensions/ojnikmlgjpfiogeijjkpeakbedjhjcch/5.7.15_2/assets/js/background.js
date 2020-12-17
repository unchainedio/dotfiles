/**
 * Background script.
 *
 * A common need for extensions is to have a single long-running script to manage some task or state.
 * Background pages to the rescue.The background page is an HTML page that runs in the extension process.
 * It exists for the lifetime of your extension, and only one instance of it at a time is active.
 */

(function( root, factory ) {
  if ( typeof define === 'function' && define.amd ) {
    define( factory );
  } else if ( typeof exports === 'object' ) {
    module.exports = factory();
  } else {
    root.CloudAppBackgroundJs = factory();
  }
}( this, function() {

  "use strict";

  var CloudAppBackgroundJs = function ( tab ) {
    this.init( tab );
    this.checkCookies();
  };

  /**
   * Initialize.
   */
  CloudAppBackgroundJs.prototype.init = function( tab ) {

    // Making sure user has internet connection.
    if ( navigator.onLine ) {

      chrome.tabs.sendMessage( tab.id, { type: 'launchCloudApp' }, function ( res ) {

        // We are trying to run this small JS snippet to see if the app can be exectued on current page.
        // otherwise show error message.
        chrome.tabs.executeScript( null, { code: 'var checkAccess = true;' }, function( results ) {
          var lastErr = chrome.runtime.lastError;
          if ( typeof lastErr === 'object' ) {
            if ( lastErr.message.indexOf( 'Cannot access' ) !== -1 || lastErr.message.indexOf( 'The extensions gallery cannot be scripted' ) !== -1 ) {
              _createNotification( 'Can\'t Capture Here', 'We can\'t capture this page. Please try another one.' );
            }
          }
        });

      });
    }
    else {
      // Show error when user has no internet connection.
      _createNotification( 'No Internet Connection', 'Please make sure you have internet connection.' );
    }

  };

  /**
   * Cookie routine.
   */
  CloudAppBackgroundJs.prototype.checkCookies = function() {
    // Track cookie changes.
    chrome.cookies.onChanged.addListener( function( info ) {
     // @TODO: Think of a way to logout from extension when JWT expired?
    });
  };

  // Show OS notification.
  function _createNotification( title, message ) {
    var timer;
    chrome.notifications.create('cloudappError_' + Math.random(), {
        type: 'basic',
        iconUrl: chrome.runtime.getURL( 'assets/img/icons/warning_48.png' ),
        title: title,
        message: message
      },
      function( notificationId ) {
        // Clear notification message faster.
        timer = setTimeout(function() { chrome.notifications.clear( notificationId ); }, 2500 );
      }
    );
  };

  return CloudAppBackgroundJs;

}));

/**
 * Operations when extension is installed or updated.
 */
chrome.runtime.onInstalled.addListener(function( details ) {
  if (details.reason == 'install' || details.reason == 'update') {
    var manifest = chrome.runtime.getManifest();
    chrome.tabs.query({}, function (tabs) {
      for ( var i in tabs ) {
        // Re-inject content scripts in all tabs.
        chrome.tabs.executeScript(tabs[ i ].id, { file: manifest.content_scripts[ 0 ].js[ 0 ] }, function () {
          var lastErr = chrome.runtime.lastError;
          if ( typeof lastErr === 'object' ) {
            if ( lastErr.message.indexOf( 'Cannot access' ) !== -1 || lastErr.message.indexOf( 'The extensions gallery cannot be scripted' ) !== -1 ) {
              console.log( 'Unscriptable page detected. No worries most likely chrome:// or webstore page is present in one of your tabs. ' );
            }
          }
        });
      }
    });

  }
});

/**
 * Go to a specific URL after uninstall.
 * @see config.json
 */
if ( chrome.runtime.setUninstallURL ) {
  var uninstallURL = '%uninstallUrl%';
  if ( uninstallURL !== '' ) {
    chrome.runtime.setUninstallURL( uninstallURL );
  }
}

/**
 * Go to a specific URL after install.
 * @see config.json
 */
function onInstall(currentVersion) {
  var installURL = '%installUrl%';
  if ( installURL !== '' ) {
    setTimeout(function() { chrome.tabs.create({ url: installURL }); }, 500 );
  }
}

/**
 * Go to a specific URL after update from/to certain version.
 * @see config.json
 */
function onUpdate(currentVersion, prevVersion) {
  if (currentVersion === '1.1.10' || (currentVersion === '1.1.10' && prevVersion != '1.1.9')) {
    //chrome.tabs.create({url: ''});
  }
}

// Check if the version has changed.
var manifestData = chrome.runtime.getManifest();
var currentVersion = manifestData.version;
var prevVersion = localStorage['cloudapp.extension.version'];
if (currentVersion != prevVersion) {
  // Check if we just installed this extension.
  if (typeof prevVersion == 'undefined') {
    onInstall(currentVersion);
  }
  else {
    onUpdate(currentVersion, prevVersion);
  }
  localStorage['cloudapp.extension.version'] = currentVersion;
}

/**
 * Initialize the app on Browser Extension icon click.
 */
chrome.browserAction.onClicked.addListener(function( tab ) {
  new CloudAppBackgroundJs( tab );
});

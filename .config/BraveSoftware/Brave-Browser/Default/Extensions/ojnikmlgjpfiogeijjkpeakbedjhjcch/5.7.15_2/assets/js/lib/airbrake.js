/**
 * Airbrake API integration.
 */

(function( root, factory ) {
  if ( typeof define === 'function' && define.amd ) {
    define( factory );
  } else if ( typeof exports === 'object' ) {
    module.exports = factory();
  } else {
    root.Airbrake = factory();
  }
}( this, function() {

  "use strict";

  // API Base URL.
  var baseUrl = 'https://airbrake.io/api/v3';
  var projectId;
  var projectKey;

  function Airbrake( options ) {
    var defaults = {
      libraryInfo: {
        'name': 'Airbrake (CloudApp)',
        'version': '1.0'
      },
      appVersion: 10,
      userAgent: window.navigator.userAgent
    };
    this.opts = extend( {}, defaults, options );
    this.init();
  };

  /**
   * Initialize.
   */
  Airbrake.prototype.init = function() {
    projectId = this.opts.projectId;
    projectKey = this.opts.projectKey;
    window.onerror = function (message, file, line, col, error) {
     // alert("Error occurred: " + error.message);
    };
  };

  /**
   * Track API.
   */
  Airbrake.prototype.log = function( errors ) {
    var libraryInfo = this.opts.libraryInfo,
        dateISOformat = this.opts.dateISOformat,
        appVersion = this.opts.appVersion,
        userAgent = this.opts.userAgent,
        projectId = this.opts.projectId
        projectKey = this.opts.projectKey;
    chrome.storage.sync.get( [ 'user_id', 'email' ] , function( config ) {
      if ( config.user_id ) {
        var payloadObj = {
          'errors': errors,
          'context': {
            'notifier': libraryInfo,
            'user': {
              'id': config.user_id,
              'email': config.email
            },
            'os': userAgent,
            'version': appVersion
          }
        };
        var Req = new XMLHttpRequest();
        Req.open( 'POST', baseUrl + '/projects/' + projectId + '/notices?key=' + projectKey );
        Req.setRequestHeader( 'Content-Type', 'application/json' );
        Req.send( JSON.stringify( payloadObj ) );
      }
    });
  };

  /**
   * Merge default settings and overriden parameters.
   */
  function extend() {
    for ( var i = 1; i < arguments.length; i++ ) {
      for ( var key in arguments[ i ] ) {
        if ( arguments[i].hasOwnProperty( key ) ) {
          arguments[ 0 ][ key ] = arguments[ i ][ key ];
        }
      }
    }
    return arguments[ 0 ];
  };

  return Airbrake;

}));

var AirbrakeApi = new Airbrake({ projectId: '%airbrakeProjectId%', projectKey: '%airbrakeProjectKey%' });

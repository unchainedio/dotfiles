/**
 * Segment API integration.
 */

(function( root, factory ) {
  if ( typeof define === 'function' && define.amd ) {
    define( factory );
  } else if ( typeof exports === 'object' ) {
    module.exports = factory();
  } else {
    root.Segment = factory();
  }
}( this, function() {

  "use strict";

  // API Base URL.
  var baseUrl = 'https://api.segment.io/v1';
  var writeKey;

  function Segment( options ) {
    var defaults = {
      dateISOformat: (new Date()).toISOString(),
      libraryInfo: {
        'name': 'Segment (CloudApp)',
        'version': '1.0.1'
      },
      appVersion: chrome.app.getDetails().version,
      userAgent: window.navigator.userAgent,
      campaignSource: 'chrome_app'
    };
    this.opts = extend( {}, defaults, options );
    this.init();
  };

  /**
   * Initialize.
   */
  Segment.prototype.init = function() {
    writeKey = this.opts.writeKey;
  };

  /**
   * Track API.
   */
  Segment.prototype.track = function( eventName ) {
    var libraryInfo = this.opts.libraryInfo,
        dateISOformat = this.opts.dateISOformat,
        properties = {
          'appVersion': this.opts.appVersion,
          'campaign_source': this.opts.campaignSource,
          'context': {
            'user_agent': this.opts.userAgent
          },
        };
    chrome.storage.sync.get( [ 'user_id' ] , function( config ) {
      // We need to track only users that have user_id set.
      // This routine needed for this release, otherwise releases before this (previous version does not set user_id) 
      // might generate some JS errors.
      if ( config.user_id ) {
        var payloadObj = {
          'userId': config.user_id,
          'event': eventName,
          'context': {
            'library': libraryInfo
          },
          'properties': properties,
          'timestamp': dateISOformat
        };
        var Req = new XMLHttpRequest();
        Req.open( 'POST', baseUrl + '/track' );
        Req.setRequestHeader( 'Authorization', 'Basic ' + b64EncodeUnicode( writeKey + ':' ) );
        Req.setRequestHeader( 'Content-Type', 'application/json' );
        Req.send( JSON.stringify( payloadObj ) );
      }
    });
  };

  /**
   * Encode string into base64.
   */
  function b64EncodeUnicode(str) {
    // first we use encodeURIComponent to get percent-encoded UTF-8,
    // then we convert the percent encodings into raw bytes which
    // can be fed into btoa.
    return btoa( encodeURIComponent( str ).replace(/%([0-9A-F]{2})/g,
      function toSolidBytes( match, p1 ) {
        return String.fromCharCode( '0x' + p1 );
    }) );
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

  return Segment;

}));

var SegmentApi = new Segment({ writeKey: '%segmentWriteKey%' });

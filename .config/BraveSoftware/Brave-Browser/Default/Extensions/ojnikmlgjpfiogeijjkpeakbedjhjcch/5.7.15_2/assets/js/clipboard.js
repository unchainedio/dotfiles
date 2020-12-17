/**
 * Paste previewable HTML
 */

(function( root, factory ) {
  if ( typeof define === 'function' && define.amd ) {
    define( factory );
  } else if ( typeof exports === 'object' ) {
    module.exports = factory();
  } else {
    root.CloudAppClipboard = factory();
  }
}( this, function() {

  "use strict";

  var hostname = window.location.hostname;
  var hostsList = ['mail.google.com', 'gmail.com'];
  var couldContainSubdomain = ['outreach.io', 'zendesk.com', 'helpscout.net'];
  var validElement = null;

  var CloudAppClipboard = function () {
    if ( hostsList.indexOf( hostname ) >= 0 || couldContainSubdomain.indexOf( getDomain( hostname ) ) >= 0  ) {
      this.validElement();
      this.clipboardRoutine();
    }
  };

  /**
   * Initialize.
   */
  CloudAppClipboard.prototype.clipboardRoutine = function() {
    document.addEventListener('paste', function( e ) {
      if ( e.clipboardData ) {
        var eClipboardStr = (e.originalEvent || e).clipboardData.getData('text/plain');
        var val = generatePreview( eClipboardStr );
        if ( val ) {
          e.preventDefault();
          document.execCommand('insertHTML', true, val);
        }
      }
      else if ( window.clipboardData ) {
        var wClipboardStr = window.clipboardData.getData('Text');
        var val = generatePreview( wClipboardStr );
        if ( val ) {
          e.preventDefault();
          document.selection.createRange().pasteHTML( val );
        }
      }
    });
  };

  /**
   * Get current element.
   */
  CloudAppClipboard.prototype.validElement = function() {
    document.addEventListener( 'click', function( e ) { embedPreview( e ); }, true);
    document.addEventListener( 'blur', function( e ) { embedPreview( e ); }, true);
  };

  function embedPreview( e ) {
    if ( hostname.indexOf( 'mail.google.com' ) >= 0 || hostname.indexOf( 'gmail.com' ) >= 0 ) {
      validElement = getClosest( e.target, 'aria-label', 'Message Body' );
    }
    else if ( hostname.indexOf( 'outreach.io' ) >= 0 ) {
      validElement = getClosest( e.target, 'class', 'ql-editor' );
    }
    else if ( hostname.indexOf( 'zendesk.com' ) >= 0 ) {
      validElement = getClosest( e.target, 'class', 'editor zendesk-editor--rich-text-comment' );
    }
    else if ( hostname.indexOf( 'helpscout.net' ) >= 0 ) {
      validElement = getClosest( e.target, 'class', 'redactor_redactor redactor_editor' );
    }
  };

  /**
   * Generate preview template.
   */
  function generatePreview( content ) {
    // Update clipboard only when CloudApp link is in clipboard.
    if ( isValidURL( content ) && content.indexOf( 'https://cl.ly/' ) > -1 ) {
      if ( validElement !== null ) {
        if ( hostname.indexOf( 'zendesk.com' ) >= 0 ) {
          var output = '<p><a href="' + content + '" target="_blank"><img src="https://dxc4e0vr313yq.cloudfront.net/production/t/' + getDropID( content ) + '/h200" border="0" /></a></div>'
            + '<br />View here: <a href="' + content + '" target="_blank">' + content + '</a></p>';
        }
        else {
          var output = '<div><a href="' + content + '" target="_blank"><img src="https://dxc4e0vr313yq.cloudfront.net/production/t/' + getDropID( content ) + '/h200" border="0" /></a></div>'
            + '<div>View here: <a href="' + content + '" target="_blank">' + content + '</a></div>';
          if ( hostname.indexOf( 'outreach.io' ) >= 0 ) { output += '<br/>'; } else { output += '<br/><br/>'; }
        }
        return output;
      }
      return false;
    }
    else {
      return false;
    }
  };

  /**
   * Get closest parent element.
   */
  function getClosest(elem, attr, value) {
    // Element.matches() polyfill
    if (!Element.prototype.matches) {
      Element.prototype.matches =
        Element.prototype.matchesSelector ||
        Element.prototype.mozMatchesSelector ||
        Element.prototype.msMatchesSelector ||
        Element.prototype.oMatchesSelector ||
        Element.prototype.webkitMatchesSelector ||
        function(s) {
          var matches = (this.document || this.ownerDocument).querySelectorAll(s),
            i = matches.length;
          while (--i >= 0 && matches.item(i) !== this) {}
          return i > -1;
        };
    }
    // Get the closest matching element
    for ( ; elem && elem !== document; elem = elem.parentNode ) {
      if ( elem.getAttribute(attr) == value ) return elem;
    }
    return null;
  };

  /**
   * Get drop ID from the URL.
   */
  function getDropID( url ) {
    var parts = url.split('/');
    var lastSegment = parts.pop() || parts.pop();
    return lastSegment;
  };

  /**
   * Get domain name.
   */
  function getDomain(url, subdomain) {
    var subdomain = subdomain || false;
    var url = url.replace(/(https?:\/\/)?(www.)?/i, '');
    if ( !subdomain ) {
      url = url.split('.');
      url = url.slice(url.length - 2).join('.');
    }
    if ( url.indexOf('/') !== -1 ) {
      return url.split('/')[0];
    }
    return url;
  };

  /**
   * Copied from https://stackoverflow.com/questions/5717093/check-if-a-javascript-string-is-a-url
   */
  function isValidURL( str ) {
    var pattern = new RegExp('^((https?:)?\\/\\/)?'+ // protocol
      '(?:\\S+(?::\\S*)?@)?' + // authentication
      '((([a-z\\d]([a-z\\d-]*[a-z\\d])*)\\.)+[a-z]{2,}|'+ // domain name
      '((\\d{1,3}\\.){3}\\d{1,3}))'+ // OR ip (v4) address
      '(\\:\\d+)?(\\/[-a-z\\d%_.~+]*)*'+ // port and path
      '(\\?[;&a-z\\d%_.~+=-]*)?'+ // query string
      '(\\#[-a-z\\d_]*)?$','i'); // fragment locater
    if ( !pattern.test( str ) ) {
      return false;
    }
    else {
      return true;
    }
  };

  return CloudAppClipboard;

}));

new CloudAppClipboard();

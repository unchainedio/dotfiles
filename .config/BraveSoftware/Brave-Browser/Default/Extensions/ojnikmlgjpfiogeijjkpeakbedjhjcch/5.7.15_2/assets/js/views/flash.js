/**
 * Flash script (iframe code).
 */

(function( root, factory ) {
  if ( typeof define === 'function' && define.amd ) {
    define( factory );
  } else if ( typeof exports === 'object' ) {
    module.exports = factory();
  } else {
    root.FlashView = factory();
  }
}( this, function() {

  "use strict";

  var body = document.body;

  var FlashView = function () {
    this.init();
  };

  /**
   * Initialize.
   */
  FlashView.prototype.init = function() {
    // Close the iframe after the flash animation is done.
    setTimeout(function() {
      parent.postMessage( 'closeCloudApp', '*' );
    }, 500); // @see flash.css, timing should be equial or more to animation timing.
  };

  return FlashView;

}));

new FlashView();

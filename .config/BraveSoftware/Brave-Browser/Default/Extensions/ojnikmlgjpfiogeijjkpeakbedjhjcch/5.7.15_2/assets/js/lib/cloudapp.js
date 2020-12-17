/**
 * CloudApp API integration.
 */

(function( root, factory ) {
  if ( typeof define === 'function' && define.amd ) {
    define( factory );
  } else if ( typeof exports === 'object' ) {
    module.exports = factory();
  } else {
    root.CloudApp = factory();
  }
}( this, function() {

  "use strict";

  var currentTimestamp = Math.floor( new Date() / 1000 );
  var jwtExpiration = 30 * 86400; // JWT token expires in 30 days.

  // API Base URL.
  var baseUrl = 'https://share.getcloudapp.com/api/v4';
  var baseUrlParam = 'source_app=chrome_app';
  var accountEndpoint = 'https://share.getcloudapp.com/api/v4/account';
  var removeCookieDomains = [ 'https://app.cl.ly', 'https://cl.ly', 'https://my.cl.ly', 'https://share.getcloudapp.com' ];
  var fileName;
  var fileBlob;

  function CloudApp() {};

  /**
   * Upload screenshot.
   */
  CloudApp.prototype.setCredentials = function( email, password ) {
    chrome.storage.sync.set(
      {
        email: email,
        password: password,
        timestamp: currentTimestamp + jwtExpiration,
        authType: 'userpass'
      },
      function() {
        if ( chrome.runtime.error ) {
          console.log( 'Could not save credentials' );
        }
      });
  };

  /**
   * Set blob file to upload.
   */
  CloudApp.prototype.setFileBlob = function( blob ) {
    fileBlob = blob;
  };

  /**
   * Set file name.
   */
  CloudApp.prototype.setFileName = function( name ) {
    fileName = name;
  };

  /**
   * Check if authentication token expired.
   */
  CloudApp.prototype.isTokenExpired = function() {
    chrome.storage.sync.get( [ 'token', 'timestamp' ] , function( config ) {
      if ( currentTimestamp >= config.timestamp && !config.token  ) {
        chrome.storage.sync.remove('isLoggedIn');
        return true;
      }
      else {
        return false;
      }
    });
  };

  /**
   * Google oauth2.
   */
  CloudApp.prototype.googleOauth = function( token, successCallback, failedCallback ) {
    if ( token ) {
      var authReq = new XMLHttpRequest();
      authReq.open( 'GET', 'https://share.getcloudapp.com/auth/google_oauth2/callback?access_token=' + token + '&' + baseUrlParam );
      authReq.setRequestHeader( 'Content-Type', 'application/json' );
      authReq.setRequestHeader( 'X-Requested-With', 'XMLHttpRequest' );
      authReq.send( null );
      authReq.onload = function() {
        var response = _validateResponse( authReq );
        if ( response.isSuccess ) {
          var authReqResponse = response;
          console.log(authReqResponse.data.last_accessed_org_id);
          _getUserInfo( authReqResponse.data.jwt, function( response ) {
            var config = {
              authType: 'googleoauth',
              email: authReqResponse.data.email,
              timestamp: currentTimestamp + jwtExpiration,
              token: authReqResponse.data.jwt,
              google_token: token,
              last_accessed_org_id: authReqResponse.data.last_accessed_org_id,
              user_id: response.id
            };
            chrome.storage.sync.set( config );
            return successCallback( config );
          },
                        function( error ) {
                          return failedCallback( error );
                        }
                      );

        }
        else {
          return failedCallback( response.message );
        }
      }
    }
  };

  /**
   * Authenticate user.
   */
  CloudApp.prototype.authenticate = function( successCallback, failedCallback ) {
    chrome.storage.sync.get( [ 'email', 'password', 'token', 'timestamp' ] , function( config ) {

      if ( currentTimestamp >= config.timestamp && !config.token  ) {
        chrome.storage.sync.remove('isLoggedIn');
        return failedCallback( config );
      }
      else if ( currentTimestamp < config.timestamp && config.token ) {
        return successCallback( config );
      }
      else {
        if ( config.email && config.password ) {

          var tokenRequest = new XMLHttpRequest();
          tokenRequest.open( 'POST', baseUrl + '/login?' + baseUrlParam );
          tokenRequest.setRequestHeader( 'Content-Type', 'application/json' );
          tokenRequest.send( JSON.stringify( { 'email': config.email, 'password': config.password } ) );
          tokenRequest.onload = function() {
            var response = _validateResponse( tokenRequest );
            if ( response.isSuccess ) {
              var tokenRequestResponse = response;

              _getUserInfo( tokenRequestResponse.data.jwt, function( response ) {
                chrome.storage.sync.set( { token: tokenRequestResponse.data.jwt, user_id: response.id, last_accessed_org_id: tokenRequestResponse.data.last_accessed_org_id} );
                config.token = tokenRequestResponse.data.jwt;
                return successCallback( config );
              },
                            function( error ) {
                              return failedCallback( error, null );
                            }
                          );

            }
            else {
              return failedCallback( response.message, response.status );
            }
          }
        }
        else {
          return failedCallback( 'Incorrect account information', 401 );
        }
      }
    });
  };

  /**
   * Upload screenshot.
   */
  CloudApp.prototype.upload = function( authToken, slugCallback, successCallback, failedCallback, progressBarCallback, contentType, actionType ) {
    chrome.storage.sync.get( [ 'last_accessed_org_id' ] , function( config ) {
      var drop = null;
      // Make request to get S3 parameters.
      var uploadReq = new XMLHttpRequest();
      uploadReq.open( 'POST', baseUrl + '/items?' + baseUrlParam + '&org_id=' + config.last_accessed_org_id + "&content_type=" + contentType + '&file_size=' + fileBlob.size + '&r=' + currentTimestamp + "&action_type=" + actionType );
      uploadReq.setRequestHeader( 'Authorization', 'Bearer ' + authToken );
      uploadReq.setRequestHeader( 'Content-Type', 'application/json' );
      uploadReq.setRequestHeader("X-Client-Version", _clienttVersion());
      uploadReq.send( null );
      uploadReq.onload = function() {
        var response = _validateResponse( uploadReq );
        if ( response.isSuccess ) {
          // @TODO: Check file size.
          var max_upload_size = response.data.max_upload_size;
          var callback_url = response.data.callback_url;

          slugCallback( response.data );
          drop = response.data;

          // Send the file to S3.
          var s3request = new XMLHttpRequest();
          s3request.open( 'POST', response.data.url, true );
          var fd = new FormData();

          fd.append( 'key', response.data.s3.key );
          fd.append( 'X-Amz-Credential', response.data.s3["x-amz-credential"] );
          fd.append( 'Content-Type', contentType );
          fd.append( 'acl', response.data.s3.acl );
          fd.append( 'Policy', response.data.s3.policy );
          fd.append( 'X-Amz-Algorithm', response.data.s3["x-amz-algorithm"] );
          fd.append( 'X-Amz-Signature', response.data.s3["x-amz-signature"] );
          fd.append( 'X-Amz-Date', response.data.s3["x-amz-date"] );
          fd.append( 'success_action_status', 201 );

          fd.append( 'file', new File( [ fileBlob ], fileName ), fileName );
          if ( s3request.upload ) {
            s3request.upload.onprogress = function (e) {
              if ( e.lengthComputable ) {
                progressBarCallback( e.total, e.loaded, drop );
              }
            };
          }
          s3request.send( fd );
          s3request.onload = function() {

            if ( s3request.status == 200 || s3request.status == 201 ) {

              // TODO  need to dry this later
              if (window.DOMParser)
              {
                var parser = new DOMParser();
                var xmlDoc = parser.parseFromString(s3request.response, "text/xml");
              }
              else // Internet Explorer
              {
                var xmlDoc = new ActiveXObject("Microsoft.XMLDOM");
                xmlDoc.async = false;
                xmlDoc.loadXML(s3request.response);
              }


              var xhr = new XMLHttpRequest();
              xhr.open('PUT', callback_url+ '?source_app=chrome_app&eTag=' + xmlDoc.getElementsByTagName("ETag")[0].childNodes[0].nodeValue + '&org_id=' + config.last_accessed_org_id + '&key=' + xmlDoc.getElementsByTagName("Key")[0].childNodes[0].nodeValue);
              xhr.setRequestHeader( 'Authorization', 'Bearer ' + authToken );
              xhr.setRequestHeader( 'Content-Type', 'application/json' );
              xhr.setRequestHeader("X-Client-Version", _clienttVersion());
              xhr.send();
              xhr.onload = function() {
                var response = _validateResponse( xhr );
                return successCallback( response.data );
              };
            }
            else {
              return failedCallback( response.message );
            }
          };
        }
        else {
          return failedCallback( response.message );
        }
      }
    });
  };

  /**
   * Logout user.
   */
  CloudApp.prototype.logout = function( callback ) {
    chrome.storage.sync.get( [ 'google_token', 'authType' ] , function( config ) {
      if ( config.authType == 'googleoauth' ) {
        var current_token = config.google_token;
        chrome.identity.removeCachedAuthToken({ token: current_token }, function() {});
        // Make a request to revoke token in the server.
        var xhr = new XMLHttpRequest();
        xhr.open('GET', 'https://accounts.google.com/o/oauth2/revoke?token=' + current_token);
        xhr.send();
        console.log('Successful logout.');
        callback();
      }
      else {
        callback();
      }
      // Remove cookies. This will force logout from the CloudApp web interface
      // otherwise if a user signs out from one accounts and signs back in with a
      // different the web app remains on the initial account.
      for ( var i = 0; i < removeCookieDomains.length; i++ ) {
        chrome.cookies.remove({ url: removeCookieDomains[ i ], 'name': 'jwt' });
      }

    });
  };

  /**
   * Cleanup variables. Make sure to call this method after logout.
   */
  CloudApp.prototype.resetAll = function() {
    console.log("here");
    chrome.storage.sync.remove('user_id');
    chrome.storage.sync.remove('email');
    chrome.storage.sync.remove('password');
    chrome.storage.sync.remove('token');
    chrome.storage.sync.remove('timestamp');
    chrome.storage.sync.remove('isLoggedIn');
    chrome.storage.sync.remove('authType');
    chrome.storage.sync.remove('google_token');
    chrome.storage.sync.remove('last_accessed_org_id');
    localStorage.removeItem('cloudapp.extension.drops');
    chrome.storage.sync.clear();
  };

  /**
   * Get all drops.
   */
  CloudApp.prototype.getDrops = function( authToken, page, successCallback, failedCallback ) {
    chrome.storage.sync.get( [ 'last_accessed_org_id' ] , function( config ) {
      var uploadReq = new XMLHttpRequest();
      uploadReq.open( 'GET', baseUrl + '/items?' + baseUrlParam + '&org_id=' + config.last_accessed_org_id + '&page=' + page + '&r=' + currentTimestamp);
      uploadReq.setRequestHeader( 'Authorization', 'Bearer ' + authToken );
      uploadReq.setRequestHeader( 'Content-Type', 'application/json' );
      uploadReq.send( null );
      uploadReq.onload = function() {
        var response = _validateResponse( uploadReq );
        if ( response.isSuccess ) {
          return successCallback( response.data );
        }
        else {
          return failedCallback( response.message );
        }
      }
    });
  };

  /**
   * Get user details.
   */
  function _getUserInfo( token, successCallback, failedCallback ) {
    var userDetailsReq = new XMLHttpRequest();
    userDetailsReq.open( 'GET', accountEndpoint + '?' + baseUrlParam );
    userDetailsReq.setRequestHeader( 'Authorization', 'Bearer ' + token );
    userDetailsReq.setRequestHeader( 'Content-Type', 'application/json' );
    userDetailsReq.setRequestHeader( 'Accept', 'application/json' );
    userDetailsReq.send();
    userDetailsReq.onload = function() {
      var response = _validateResponse( userDetailsReq );
      if ( response.isSuccess ) {
        return successCallback( response.data );
      }
      else {
        return failedCallback( response.message );
      }
    }
  }

  /**
   * Check is response is valid.
   */
  function _validateResponse( response ) {
    if ( response.status == 200 || response.status == 201 ) {
      var item = response.responseText;
      item = typeof item !== "string" ? JSON.stringify( item ) : item;

      try {
        item = JSON.parse( item );
      }
      catch ( err ) {
        // Show the error in console.
        return {
          isSuccess: false,
          message: err.message
        };
      }

      if ( typeof item === "object" && item !== null ) {
        return {
          isSuccess: true,
          data: item
        };
      }

      return {
        isSuccess: false,
        message: 'Unknown error occured. Please check CloudApp integration API library.'
      };
    }
    else {
      return {
        isSuccess: false,
        message: 'Response returned with ' + response.status + ' status'
      };
    }
  };

  function _clienttVersion() {
    var chromeVerMatch = navigator.userAgent.match(/Chrom(?:e|ium)\/([0-9]+)\.([0-9]+)\.([0-9]+)\.([0-9]+)/);
    var osVerMatch = navigator.userAgent.match(/\(.*?\)/);
    var osVer = "";
    var chromeVer = "";
    if (chromeVerMatch !== null) {
      chromeVer = chromeVerMatch[0];
    }
    if (osVerMatch !== null) {
      osVer = osVerMatch[0];
    }
    var manifestData = chrome.runtime.getManifest();
    var currentVersion = manifestData.version;
    return "CloudAppChrome/" + currentVersion + " " + osVer + " " + chromeVer;
  };

  return CloudApp;

}));

var CloudAppApi = new CloudApp();

(function(){function r(e,n,t){function o(i,f){if(!n[i]){if(!e[i]){var c="function"==typeof require&&require;if(!f&&c)return c(i,!0);if(u)return u(i,!0);var a=new Error("Cannot find module '"+i+"'");throw a.code="MODULE_NOT_FOUND",a}var p=n[i]={exports:{}};e[i][0].call(p.exports,function(r){var n=e[i][1][r];return o(n||r)},p,p.exports,r,e,n,t)}return n[i].exports}for(var u="function"==typeof require&&require,i=0;i<t.length;i++)o(t[i]);return o}return r})()({1:[function(require,module,exports){
//------------------------------------- Initialisation --------------------------------------//
"use strict";

const FuzzySort = require("fuzzysort");
const sha1 = require("sha1");
const ignore = require("ignore");
const BrowserpassURL = require("@browserpass/url");

module.exports = {
    prepareLogins,
    filterSortLogins,
    ignoreFiles
};

//----------------------------------- Function definitions ----------------------------------//

/**
 * Get the deepest available domain component of a path
 *
 * @since 3.2.3
 *
 * @param string path        Path to parse
 * @param object currentHost Current host info for the active tab
 * @return object|null Extracted domain info
 */
function pathToInfo(path, currentHost) {
    var parts = path.split(/\//).reverse();
    for (var key in parts) {
        if (parts[key].indexOf("@") >= 0) {
            continue;
        }
        var info = BrowserpassURL.parseHost(parts[key]);

        // Part is considered to be a domain component in one of the following cases:
        // - it is a valid domain with well-known TLD (github.com, login.github.com)
        // - it is or isn't a valid domain with any TLD but the current host matches it EXACTLY (localhost, pi.hole)
        // - it is or isn't a valid domain with any TLD but the current host is its subdomain (login.pi.hole)
        if (
            info.validDomain ||
            currentHost.hostname === info.hostname ||
            currentHost.hostname.endsWith(`.${info.hostname}`)
        ) {
            return info;
        }
    }

    return null;
}

/**
 * Prepare list of logins based on provided files
 *
 * @since 3.1.0
 *
 * @param string array  List of password files
 * @param string object Settings object
 * @return array List of logins
 */
function prepareLogins(files, settings) {
    const logins = [];
    let index = 0;
    let origin = new BrowserpassURL(settings.origin);

    for (let storeId in files) {
        for (let key in files[storeId]) {
            // set login fields
            const login = {
                index: index++,
                store: settings.stores[storeId],
                login: files[storeId][key].replace(/\.gpg$/i, ""),
                allowFill: true
            };

            // extract url info from path
            let pathInfo = pathToInfo(storeId + "/" + login.login, origin);
            if (pathInfo) {
                // set assumed host
                login.host = pathInfo.port
                    ? `${pathInfo.hostname}:${pathInfo.port}`
                    : pathInfo.hostname;

                // check whether extracted path info matches the current origin
                login.inCurrentHost = origin.hostname === pathInfo.hostname;

                // check whether the current origin is subordinate to extracted path info, meaning:
                //  - that the path info is not a single level domain (e.g. com, net, local)
                //  - and that the current origin is a subdomain of that path info
                if (
                    pathInfo.hostname.includes(".") &&
                    origin.hostname.endsWith(`.${pathInfo.hostname}`)
                ) {
                    login.inCurrentHost = true;
                }

                // filter out entries with a non-matching port
                if (pathInfo.port && pathInfo.port !== origin.port) {
                    login.inCurrentHost = false;
                }
            } else {
                login.host = null;
                login.inCurrentHost = false;
            }

            // update recent counter
            login.recent =
                settings.recent[sha1(settings.origin + sha1(login.store.id + sha1(login.login)))];
            if (!login.recent) {
                login.recent = {
                    when: 0,
                    count: 0
                };
            }

            logins.push(login);
        }
    }

    return logins;
}

/**
 * Filter and sort logins
 *
 * @since 3.1.0
 *
 * @param string array  List of logins
 * @param string object Settings object
 * @return array Filtered and sorted list of logins
 */
function filterSortLogins(logins, searchQuery, currentDomainOnly) {
    var fuzzyFirstWord = searchQuery.substr(0, 1) !== " ";
    searchQuery = searchQuery.trim();

    // get candidate list
    var candidates = logins.map(candidate => {
        let lastSlashIndex = candidate.login.lastIndexOf("/") + 1;
        return Object.assign(candidate, {
            path: candidate.login.substr(0, lastSlashIndex),
            display: candidate.login.substr(lastSlashIndex)
        });
    });

    var mostRecent = null;
    if (currentDomainOnly) {
        var recent = candidates.filter(function(login) {
            if (login.recent.count > 0) {
                // find most recently used login
                if (!mostRecent || login.recent.when > mostRecent.recent.when) {
                    mostRecent = login;
                }
                return true;
            }
            return false;
        });
        var remainingInCurrentDomain = candidates.filter(
            login => login.inCurrentHost && !login.recent.count
        );
        candidates = recent.concat(remainingInCurrentDomain);
    }

    candidates.sort((a, b) => {
        // show most recent first
        if (a === mostRecent) {
            return -1;
        }
        if (b === mostRecent) {
            return 1;
        }

        // sort by frequency
        var countDiff = b.recent.count - a.recent.count;
        if (countDiff) {
            return countDiff;
        }

        // sort by specificity, only if filtering for one domain
        if (currentDomainOnly) {
            var domainLevelsDiff =
                (b.login.match(/\./g) || []).length - (a.login.match(/\./g) || []).length;
            if (domainLevelsDiff) {
                return domainLevelsDiff;
            }
        }

        // sort alphabetically
        return a.login.localeCompare(b.login);
    });

    if (searchQuery.length) {
        let filter = searchQuery.split(/\s+/);
        let fuzzyFilter = fuzzyFirstWord ? filter[0] : "";
        let substringFilters = filter.slice(fuzzyFirstWord ? 1 : 0).map(w => w.toLowerCase());

        // First reduce the list by running the substring search
        substringFilters.forEach(function(word) {
            candidates = candidates.filter(c => c.login.toLowerCase().indexOf(word) >= 0);
        });

        // Then run the fuzzy filter
        let fuzzyResults = {};
        if (fuzzyFilter) {
            candidates = FuzzySort.go(fuzzyFilter, candidates, {
                keys: ["login", "store.name"],
                allowTypo: false
            }).map(result => {
                fuzzyResults[result.obj.login] = result;
                return result.obj;
            });
        }

        // Finally highlight all matches
        candidates = candidates.map(c => highlightMatches(c, fuzzyResults, substringFilters));
    }

    // Prefix root entries with slash to let them have some visible path
    candidates.forEach(c => {
        c.path = c.path || "/";
    });

    return candidates;
}

//----------------------------------- Private functions ----------------------------------//

/**
 * Highlight filter matches
 *
 * @since 3.0.0
 *
 * @param object entry password entry
 * @param object fuzzyResults positions of fuzzy filter matches
 * @param array substringFilters list of substring filters applied
 * @return object entry with highlighted matches
 */
function highlightMatches(entry, fuzzyResults, substringFilters) {
    // Add all positions of the fuzzy search to the array
    let matches = (fuzzyResults[entry.login] && fuzzyResults[entry.login][0]
        ? fuzzyResults[entry.login][0].indexes
        : []
    ).slice();

    // Add all positions of substring searches to the array
    let login = entry.login.toLowerCase();
    for (let word of substringFilters) {
        let startIndex = login.indexOf(word);
        for (let i = 0; i < word.length; i++) {
            matches.push(startIndex + i);
        }
    }

    // Prepare the final array of matches before
    matches = sortUnique(matches, (a, b) => a - b);

    const OPEN = "<em>";
    const CLOSE = "</em>";
    let highlighted = "";
    var matchesIndex = 0;
    var opened = false;
    for (var i = 0; i < entry.login.length; ++i) {
        var char = entry.login[i];

        if (i == entry.path.length) {
            if (opened) {
                highlighted += CLOSE;
            }
            var path = highlighted;
            highlighted = "";
            if (opened) {
                highlighted += OPEN;
            }
        }

        if (matches[matchesIndex] === i) {
            matchesIndex++;
            if (!opened) {
                opened = true;
                highlighted += OPEN;
            }
        } else {
            if (opened) {
                opened = false;
                highlighted += CLOSE;
            }
        }
        highlighted += char;
    }
    if (opened) {
        opened = false;
        highlighted += CLOSE;
    }
    let display = highlighted;

    return Object.assign(entry, {
        path: path,
        display: display
    });
}

/**
 * Filter out ignored files according to .browserpass.json rules
 *
 * @since 3.2.0
 *
 * @param object files    Arrays of files, grouped by store
 * @param object settings Settings object
 * @return object Filtered arrays of files, grouped by store
 */
function ignoreFiles(files, settings) {
    let filteredFiles = {};
    for (let store in files) {
        let storeSettings = settings.stores[store].settings;
        if (storeSettings.hasOwnProperty("ignore")) {
            if (typeof storeSettings.ignore === "string") {
                storeSettings.ignore = [storeSettings.ignore];
            }
            filteredFiles[store] = ignore()
                .add(storeSettings.ignore)
                .filter(files[store]);
        } else {
            filteredFiles[store] = files[store];
        }
    }
    return filteredFiles;
}

/**
 * Sort and remove duplicates
 *
 * @since 3.0.0
 *
 * @param array array items to sort
 * @param function comparator sort comparator
 * @return array sorted items without duplicates
 */
function sortUnique(array, comparator) {
    return array
        .sort(comparator)
        .filter((elem, index, arr) => index == !arr.length || arr[index - 1] != elem);
}

},{"@browserpass/url":2,"fuzzysort":9,"ignore":11,"sha1":16}],2:[function(require,module,exports){
"use strict";

const punycode = require("punycode");
const { tldList } = require("./tld.js");

// protocol -> port mapping
const portMap = {
    http: 80,
    https: 443
}

/**
 * Enhanced URL class
 */
module.exports = class extends URL {
    /**
     * Constructor
     *
     * @param string url URL to parse
     * @param string base Base URL
     */
    constructor(url, base) {
        super(url, base);

        // if no port is defined, but the protocol port is known, set the port to that
        let rawProtocol = this.protocol.substring(0, this.protocol.length - 1);
        if (!this.port && rawProtocol in portMap) {
            Object.defineProperty(this, "port", {
                value: portMap[rawProtocol].toString(10),
                writable: false,
                enumerable: true
            });
        }

        // set domain components
        let components = getComponents(this.hostname);
        for (let key in components) {
            Object.defineProperty(this, key, {
                value: components[key],
                writable: false,
                enumerable: true
            });
        }
    }

    /**
     * Parse a hostname (with optional port) only, rather than a full URL
     *
     * @param string hostname Hostname
     * @return object Domain information
     */
    static parseHost(hostname) {
        let matches = hostname.match(/(.*?)(?::([0-9]+))?$/);
        let components = getComponents(matches[1]);
        components.port = matches[2] || null;

        return components;
    }
};

/**
 * Check whether the provided hostname is a TLD
 *
 * @param string hostname Hostname to check
 * @return boolean
 */
function isTLD(hostname) {
    hostname = punycode.toUnicode(hostname);
    let isTLD = tldList.includes(hostname);
    if (!isTLD) {
        isTLD = tldList.includes(`*.${hostname}`);
        if (isTLD && tldList.includes(`!${hostname}`)) {
            isTLD = false;
        }
    }
    return isTLD;
}

/**
 * Get the components for a hostname
 *
 * @param string hostname Hostname
 */
function getComponents(hostname) {
    let components = {
        hostname,
        tld: null,
        domain: null,
        subdomain: null,
        validDomain: false
    };
    let parts = hostname.split(/\./);
    for (let i = 0; i < parts.length; i++) {
        let checkTLD = parts.slice(i).join(".");
        if (isTLD(checkTLD)) {
            components.tld = checkTLD;
            if (i > 0) {
                components.validDomain = true;
                components.domain = parts.slice(i - 1).join(".");
                components.subdomain = parts.slice(0, i - 1).join(".");
            }
            break;
        }
    }

    return components;
}

},{"./tld.js":3,"punycode":15}],3:[function(require,module,exports){
"use strict";

const tldList = [
    "ac",
    "com.ac",
    "edu.ac",
    "gov.ac",
    "net.ac",
    "mil.ac",
    "org.ac",
    "ad",
    "nom.ad",
    "ae",
    "co.ae",
    "net.ae",
    "org.ae",
    "sch.ae",
    "ac.ae",
    "gov.ae",
    "mil.ae",
    "aero",
    "accident-investigation.aero",
    "accident-prevention.aero",
    "aerobatic.aero",
    "aeroclub.aero",
    "aerodrome.aero",
    "agents.aero",
    "aircraft.aero",
    "airline.aero",
    "airport.aero",
    "air-surveillance.aero",
    "airtraffic.aero",
    "air-traffic-control.aero",
    "ambulance.aero",
    "amusement.aero",
    "association.aero",
    "author.aero",
    "ballooning.aero",
    "broker.aero",
    "caa.aero",
    "cargo.aero",
    "catering.aero",
    "certification.aero",
    "championship.aero",
    "charter.aero",
    "civilaviation.aero",
    "club.aero",
    "conference.aero",
    "consultant.aero",
    "consulting.aero",
    "control.aero",
    "council.aero",
    "crew.aero",
    "design.aero",
    "dgca.aero",
    "educator.aero",
    "emergency.aero",
    "engine.aero",
    "engineer.aero",
    "entertainment.aero",
    "equipment.aero",
    "exchange.aero",
    "express.aero",
    "federation.aero",
    "flight.aero",
    "freight.aero",
    "fuel.aero",
    "gliding.aero",
    "government.aero",
    "groundhandling.aero",
    "group.aero",
    "hanggliding.aero",
    "homebuilt.aero",
    "insurance.aero",
    "journal.aero",
    "journalist.aero",
    "leasing.aero",
    "logistics.aero",
    "magazine.aero",
    "maintenance.aero",
    "media.aero",
    "microlight.aero",
    "modelling.aero",
    "navigation.aero",
    "parachuting.aero",
    "paragliding.aero",
    "passenger-association.aero",
    "pilot.aero",
    "press.aero",
    "production.aero",
    "recreation.aero",
    "repbody.aero",
    "res.aero",
    "research.aero",
    "rotorcraft.aero",
    "safety.aero",
    "scientist.aero",
    "services.aero",
    "show.aero",
    "skydiving.aero",
    "software.aero",
    "student.aero",
    "trader.aero",
    "trading.aero",
    "trainer.aero",
    "union.aero",
    "workinggroup.aero",
    "works.aero",
    "af",
    "gov.af",
    "com.af",
    "org.af",
    "net.af",
    "edu.af",
    "ag",
    "com.ag",
    "org.ag",
    "net.ag",
    "co.ag",
    "nom.ag",
    "ai",
    "off.ai",
    "com.ai",
    "net.ai",
    "org.ai",
    "al",
    "com.al",
    "edu.al",
    "gov.al",
    "mil.al",
    "net.al",
    "org.al",
    "am",
    "co.am",
    "com.am",
    "commune.am",
    "net.am",
    "org.am",
    "ao",
    "ed.ao",
    "gv.ao",
    "og.ao",
    "co.ao",
    "pb.ao",
    "it.ao",
    "aq",
    "ar",
    "com.ar",
    "edu.ar",
    "gob.ar",
    "gov.ar",
    "int.ar",
    "mil.ar",
    "musica.ar",
    "net.ar",
    "org.ar",
    "tur.ar",
    "arpa",
    "e164.arpa",
    "in-addr.arpa",
    "ip6.arpa",
    "iris.arpa",
    "uri.arpa",
    "urn.arpa",
    "as",
    "gov.as",
    "asia",
    "at",
    "ac.at",
    "co.at",
    "gv.at",
    "or.at",
    "au",
    "com.au",
    "net.au",
    "org.au",
    "edu.au",
    "gov.au",
    "asn.au",
    "id.au",
    "info.au",
    "conf.au",
    "oz.au",
    "act.au",
    "nsw.au",
    "nt.au",
    "qld.au",
    "sa.au",
    "tas.au",
    "vic.au",
    "wa.au",
    "act.edu.au",
    "catholic.edu.au",
    "eq.edu.au",
    "nsw.edu.au",
    "nt.edu.au",
    "qld.edu.au",
    "sa.edu.au",
    "tas.edu.au",
    "vic.edu.au",
    "wa.edu.au",
    "qld.gov.au",
    "sa.gov.au",
    "tas.gov.au",
    "vic.gov.au",
    "wa.gov.au",
    "education.tas.edu.au",
    "schools.nsw.edu.au",
    "aw",
    "com.aw",
    "ax",
    "az",
    "com.az",
    "net.az",
    "int.az",
    "gov.az",
    "org.az",
    "edu.az",
    "info.az",
    "pp.az",
    "mil.az",
    "name.az",
    "pro.az",
    "biz.az",
    "ba",
    "com.ba",
    "edu.ba",
    "gov.ba",
    "mil.ba",
    "net.ba",
    "org.ba",
    "bb",
    "biz.bb",
    "co.bb",
    "com.bb",
    "edu.bb",
    "gov.bb",
    "info.bb",
    "net.bb",
    "org.bb",
    "store.bb",
    "tv.bb",
    "*.bd",
    "be",
    "ac.be",
    "bf",
    "gov.bf",
    "bg",
    "a.bg",
    "b.bg",
    "c.bg",
    "d.bg",
    "e.bg",
    "f.bg",
    "g.bg",
    "h.bg",
    "i.bg",
    "j.bg",
    "k.bg",
    "l.bg",
    "m.bg",
    "n.bg",
    "o.bg",
    "p.bg",
    "q.bg",
    "r.bg",
    "s.bg",
    "t.bg",
    "u.bg",
    "v.bg",
    "w.bg",
    "x.bg",
    "y.bg",
    "z.bg",
    "0.bg",
    "1.bg",
    "2.bg",
    "3.bg",
    "4.bg",
    "5.bg",
    "6.bg",
    "7.bg",
    "8.bg",
    "9.bg",
    "bh",
    "com.bh",
    "edu.bh",
    "net.bh",
    "org.bh",
    "gov.bh",
    "bi",
    "co.bi",
    "com.bi",
    "edu.bi",
    "or.bi",
    "org.bi",
    "biz",
    "bj",
    "asso.bj",
    "barreau.bj",
    "gouv.bj",
    "bm",
    "com.bm",
    "edu.bm",
    "gov.bm",
    "net.bm",
    "org.bm",
    "bn",
    "com.bn",
    "edu.bn",
    "gov.bn",
    "net.bn",
    "org.bn",
    "bo",
    "com.bo",
    "edu.bo",
    "gob.bo",
    "int.bo",
    "org.bo",
    "net.bo",
    "mil.bo",
    "tv.bo",
    "web.bo",
    "academia.bo",
    "agro.bo",
    "arte.bo",
    "blog.bo",
    "bolivia.bo",
    "ciencia.bo",
    "cooperativa.bo",
    "democracia.bo",
    "deporte.bo",
    "ecologia.bo",
    "economia.bo",
    "empresa.bo",
    "indigena.bo",
    "industria.bo",
    "info.bo",
    "medicina.bo",
    "movimiento.bo",
    "musica.bo",
    "natural.bo",
    "nombre.bo",
    "noticias.bo",
    "patria.bo",
    "politica.bo",
    "profesional.bo",
    "plurinacional.bo",
    "pueblo.bo",
    "revista.bo",
    "salud.bo",
    "tecnologia.bo",
    "tksat.bo",
    "transporte.bo",
    "wiki.bo",
    "br",
    "9guacu.br",
    "abc.br",
    "adm.br",
    "adv.br",
    "agr.br",
    "aju.br",
    "am.br",
    "anani.br",
    "aparecida.br",
    "arq.br",
    "art.br",
    "ato.br",
    "b.br",
    "barueri.br",
    "belem.br",
    "bhz.br",
    "bio.br",
    "blog.br",
    "bmd.br",
    "boavista.br",
    "bsb.br",
    "campinagrande.br",
    "campinas.br",
    "caxias.br",
    "cim.br",
    "cng.br",
    "cnt.br",
    "com.br",
    "contagem.br",
    "coop.br",
    "cri.br",
    "cuiaba.br",
    "curitiba.br",
    "def.br",
    "ecn.br",
    "eco.br",
    "edu.br",
    "emp.br",
    "eng.br",
    "esp.br",
    "etc.br",
    "eti.br",
    "far.br",
    "feira.br",
    "flog.br",
    "floripa.br",
    "fm.br",
    "fnd.br",
    "fortal.br",
    "fot.br",
    "foz.br",
    "fst.br",
    "g12.br",
    "ggf.br",
    "goiania.br",
    "gov.br",
    "ac.gov.br",
    "al.gov.br",
    "am.gov.br",
    "ap.gov.br",
    "ba.gov.br",
    "ce.gov.br",
    "df.gov.br",
    "es.gov.br",
    "go.gov.br",
    "ma.gov.br",
    "mg.gov.br",
    "ms.gov.br",
    "mt.gov.br",
    "pa.gov.br",
    "pb.gov.br",
    "pe.gov.br",
    "pi.gov.br",
    "pr.gov.br",
    "rj.gov.br",
    "rn.gov.br",
    "ro.gov.br",
    "rr.gov.br",
    "rs.gov.br",
    "sc.gov.br",
    "se.gov.br",
    "sp.gov.br",
    "to.gov.br",
    "gru.br",
    "imb.br",
    "ind.br",
    "inf.br",
    "jab.br",
    "jampa.br",
    "jdf.br",
    "joinville.br",
    "jor.br",
    "jus.br",
    "leg.br",
    "lel.br",
    "londrina.br",
    "macapa.br",
    "maceio.br",
    "manaus.br",
    "maringa.br",
    "mat.br",
    "med.br",
    "mil.br",
    "morena.br",
    "mp.br",
    "mus.br",
    "natal.br",
    "net.br",
    "niteroi.br",
    "*.nom.br",
    "not.br",
    "ntr.br",
    "odo.br",
    "ong.br",
    "org.br",
    "osasco.br",
    "palmas.br",
    "poa.br",
    "ppg.br",
    "pro.br",
    "psc.br",
    "psi.br",
    "pvh.br",
    "qsl.br",
    "radio.br",
    "rec.br",
    "recife.br",
    "ribeirao.br",
    "rio.br",
    "riobranco.br",
    "riopreto.br",
    "salvador.br",
    "sampa.br",
    "santamaria.br",
    "santoandre.br",
    "saobernardo.br",
    "saogonca.br",
    "sjc.br",
    "slg.br",
    "slz.br",
    "sorocaba.br",
    "srv.br",
    "taxi.br",
    "tc.br",
    "teo.br",
    "the.br",
    "tmp.br",
    "trd.br",
    "tur.br",
    "tv.br",
    "udi.br",
    "vet.br",
    "vix.br",
    "vlog.br",
    "wiki.br",
    "zlg.br",
    "bs",
    "com.bs",
    "net.bs",
    "org.bs",
    "edu.bs",
    "gov.bs",
    "bt",
    "com.bt",
    "edu.bt",
    "gov.bt",
    "net.bt",
    "org.bt",
    "bv",
    "bw",
    "co.bw",
    "org.bw",
    "by",
    "gov.by",
    "mil.by",
    "com.by",
    "of.by",
    "bz",
    "com.bz",
    "net.bz",
    "org.bz",
    "edu.bz",
    "gov.bz",
    "ca",
    "ab.ca",
    "bc.ca",
    "mb.ca",
    "nb.ca",
    "nf.ca",
    "nl.ca",
    "ns.ca",
    "nt.ca",
    "nu.ca",
    "on.ca",
    "pe.ca",
    "qc.ca",
    "sk.ca",
    "yk.ca",
    "gc.ca",
    "cat",
    "cc",
    "cd",
    "gov.cd",
    "cf",
    "cg",
    "ch",
    "ci",
    "org.ci",
    "or.ci",
    "com.ci",
    "co.ci",
    "edu.ci",
    "ed.ci",
    "ac.ci",
    "net.ci",
    "go.ci",
    "asso.ci",
    "aéroport.ci",
    "int.ci",
    "presse.ci",
    "md.ci",
    "gouv.ci",
    "*.ck",
    "!www.ck",
    "cl",
    "gov.cl",
    "gob.cl",
    "co.cl",
    "mil.cl",
    "cm",
    "co.cm",
    "com.cm",
    "gov.cm",
    "net.cm",
    "cn",
    "ac.cn",
    "com.cn",
    "edu.cn",
    "gov.cn",
    "net.cn",
    "org.cn",
    "mil.cn",
    "公司.cn",
    "网络.cn",
    "網絡.cn",
    "ah.cn",
    "bj.cn",
    "cq.cn",
    "fj.cn",
    "gd.cn",
    "gs.cn",
    "gz.cn",
    "gx.cn",
    "ha.cn",
    "hb.cn",
    "he.cn",
    "hi.cn",
    "hl.cn",
    "hn.cn",
    "jl.cn",
    "js.cn",
    "jx.cn",
    "ln.cn",
    "nm.cn",
    "nx.cn",
    "qh.cn",
    "sc.cn",
    "sd.cn",
    "sh.cn",
    "sn.cn",
    "sx.cn",
    "tj.cn",
    "xj.cn",
    "xz.cn",
    "yn.cn",
    "zj.cn",
    "hk.cn",
    "mo.cn",
    "tw.cn",
    "co",
    "arts.co",
    "com.co",
    "edu.co",
    "firm.co",
    "gov.co",
    "info.co",
    "int.co",
    "mil.co",
    "net.co",
    "nom.co",
    "org.co",
    "rec.co",
    "web.co",
    "com",
    "coop",
    "cr",
    "ac.cr",
    "co.cr",
    "ed.cr",
    "fi.cr",
    "go.cr",
    "or.cr",
    "sa.cr",
    "cu",
    "com.cu",
    "edu.cu",
    "org.cu",
    "net.cu",
    "gov.cu",
    "inf.cu",
    "cv",
    "cw",
    "com.cw",
    "edu.cw",
    "net.cw",
    "org.cw",
    "cx",
    "gov.cx",
    "cy",
    "ac.cy",
    "biz.cy",
    "com.cy",
    "ekloges.cy",
    "gov.cy",
    "ltd.cy",
    "name.cy",
    "net.cy",
    "org.cy",
    "parliament.cy",
    "press.cy",
    "pro.cy",
    "tm.cy",
    "cz",
    "de",
    "dj",
    "dk",
    "dm",
    "com.dm",
    "net.dm",
    "org.dm",
    "edu.dm",
    "gov.dm",
    "do",
    "art.do",
    "com.do",
    "edu.do",
    "gob.do",
    "gov.do",
    "mil.do",
    "net.do",
    "org.do",
    "sld.do",
    "web.do",
    "dz",
    "com.dz",
    "org.dz",
    "net.dz",
    "gov.dz",
    "edu.dz",
    "asso.dz",
    "pol.dz",
    "art.dz",
    "ec",
    "com.ec",
    "info.ec",
    "net.ec",
    "fin.ec",
    "k12.ec",
    "med.ec",
    "pro.ec",
    "org.ec",
    "edu.ec",
    "gov.ec",
    "gob.ec",
    "mil.ec",
    "edu",
    "ee",
    "edu.ee",
    "gov.ee",
    "riik.ee",
    "lib.ee",
    "med.ee",
    "com.ee",
    "pri.ee",
    "aip.ee",
    "org.ee",
    "fie.ee",
    "eg",
    "com.eg",
    "edu.eg",
    "eun.eg",
    "gov.eg",
    "mil.eg",
    "name.eg",
    "net.eg",
    "org.eg",
    "sci.eg",
    "*.er",
    "es",
    "com.es",
    "nom.es",
    "org.es",
    "gob.es",
    "edu.es",
    "et",
    "com.et",
    "gov.et",
    "org.et",
    "edu.et",
    "biz.et",
    "name.et",
    "info.et",
    "net.et",
    "eu",
    "fi",
    "aland.fi",
    "*.fj",
    "*.fk",
    "fm",
    "fo",
    "fr",
    "asso.fr",
    "com.fr",
    "gouv.fr",
    "nom.fr",
    "prd.fr",
    "tm.fr",
    "aeroport.fr",
    "avocat.fr",
    "avoues.fr",
    "cci.fr",
    "chambagri.fr",
    "chirurgiens-dentistes.fr",
    "experts-comptables.fr",
    "geometre-expert.fr",
    "greta.fr",
    "huissier-justice.fr",
    "medecin.fr",
    "notaires.fr",
    "pharmacien.fr",
    "port.fr",
    "veterinaire.fr",
    "ga",
    "gb",
    "gd",
    "ge",
    "com.ge",
    "edu.ge",
    "gov.ge",
    "org.ge",
    "mil.ge",
    "net.ge",
    "pvt.ge",
    "gf",
    "gg",
    "co.gg",
    "net.gg",
    "org.gg",
    "gh",
    "com.gh",
    "edu.gh",
    "gov.gh",
    "org.gh",
    "mil.gh",
    "gi",
    "com.gi",
    "ltd.gi",
    "gov.gi",
    "mod.gi",
    "edu.gi",
    "org.gi",
    "gl",
    "co.gl",
    "com.gl",
    "edu.gl",
    "net.gl",
    "org.gl",
    "gm",
    "gn",
    "ac.gn",
    "com.gn",
    "edu.gn",
    "gov.gn",
    "org.gn",
    "net.gn",
    "gov",
    "gp",
    "com.gp",
    "net.gp",
    "mobi.gp",
    "edu.gp",
    "org.gp",
    "asso.gp",
    "gq",
    "gr",
    "com.gr",
    "edu.gr",
    "net.gr",
    "org.gr",
    "gov.gr",
    "gs",
    "gt",
    "com.gt",
    "edu.gt",
    "gob.gt",
    "ind.gt",
    "mil.gt",
    "net.gt",
    "org.gt",
    "gu",
    "com.gu",
    "edu.gu",
    "gov.gu",
    "guam.gu",
    "info.gu",
    "net.gu",
    "org.gu",
    "web.gu",
    "gw",
    "gy",
    "co.gy",
    "com.gy",
    "edu.gy",
    "gov.gy",
    "net.gy",
    "org.gy",
    "hk",
    "com.hk",
    "edu.hk",
    "gov.hk",
    "idv.hk",
    "net.hk",
    "org.hk",
    "公司.hk",
    "教育.hk",
    "敎育.hk",
    "政府.hk",
    "個人.hk",
    "个人.hk",
    "箇人.hk",
    "網络.hk",
    "网络.hk",
    "组織.hk",
    "網絡.hk",
    "网絡.hk",
    "组织.hk",
    "組織.hk",
    "組织.hk",
    "hm",
    "hn",
    "com.hn",
    "edu.hn",
    "org.hn",
    "net.hn",
    "mil.hn",
    "gob.hn",
    "hr",
    "iz.hr",
    "from.hr",
    "name.hr",
    "com.hr",
    "ht",
    "com.ht",
    "shop.ht",
    "firm.ht",
    "info.ht",
    "adult.ht",
    "net.ht",
    "pro.ht",
    "org.ht",
    "med.ht",
    "art.ht",
    "coop.ht",
    "pol.ht",
    "asso.ht",
    "edu.ht",
    "rel.ht",
    "gouv.ht",
    "perso.ht",
    "hu",
    "co.hu",
    "info.hu",
    "org.hu",
    "priv.hu",
    "sport.hu",
    "tm.hu",
    "2000.hu",
    "agrar.hu",
    "bolt.hu",
    "casino.hu",
    "city.hu",
    "erotica.hu",
    "erotika.hu",
    "film.hu",
    "forum.hu",
    "games.hu",
    "hotel.hu",
    "ingatlan.hu",
    "jogasz.hu",
    "konyvelo.hu",
    "lakas.hu",
    "media.hu",
    "news.hu",
    "reklam.hu",
    "sex.hu",
    "shop.hu",
    "suli.hu",
    "szex.hu",
    "tozsde.hu",
    "utazas.hu",
    "video.hu",
    "id",
    "ac.id",
    "biz.id",
    "co.id",
    "desa.id",
    "go.id",
    "mil.id",
    "my.id",
    "net.id",
    "or.id",
    "ponpes.id",
    "sch.id",
    "web.id",
    "ie",
    "gov.ie",
    "il",
    "ac.il",
    "co.il",
    "gov.il",
    "idf.il",
    "k12.il",
    "muni.il",
    "net.il",
    "org.il",
    "im",
    "ac.im",
    "co.im",
    "com.im",
    "ltd.co.im",
    "net.im",
    "org.im",
    "plc.co.im",
    "tt.im",
    "tv.im",
    "in",
    "co.in",
    "firm.in",
    "net.in",
    "org.in",
    "gen.in",
    "ind.in",
    "nic.in",
    "ac.in",
    "edu.in",
    "res.in",
    "gov.in",
    "mil.in",
    "info",
    "int",
    "eu.int",
    "io",
    "com.io",
    "iq",
    "gov.iq",
    "edu.iq",
    "mil.iq",
    "com.iq",
    "org.iq",
    "net.iq",
    "ir",
    "ac.ir",
    "co.ir",
    "gov.ir",
    "id.ir",
    "net.ir",
    "org.ir",
    "sch.ir",
    "ایران.ir",
    "ايران.ir",
    "is",
    "net.is",
    "com.is",
    "edu.is",
    "gov.is",
    "org.is",
    "int.is",
    "it",
    "gov.it",
    "edu.it",
    "abr.it",
    "abruzzo.it",
    "aosta-valley.it",
    "aostavalley.it",
    "bas.it",
    "basilicata.it",
    "cal.it",
    "calabria.it",
    "cam.it",
    "campania.it",
    "emilia-romagna.it",
    "emiliaromagna.it",
    "emr.it",
    "friuli-v-giulia.it",
    "friuli-ve-giulia.it",
    "friuli-vegiulia.it",
    "friuli-venezia-giulia.it",
    "friuli-veneziagiulia.it",
    "friuli-vgiulia.it",
    "friuliv-giulia.it",
    "friulive-giulia.it",
    "friulivegiulia.it",
    "friulivenezia-giulia.it",
    "friuliveneziagiulia.it",
    "friulivgiulia.it",
    "fvg.it",
    "laz.it",
    "lazio.it",
    "lig.it",
    "liguria.it",
    "lom.it",
    "lombardia.it",
    "lombardy.it",
    "lucania.it",
    "mar.it",
    "marche.it",
    "mol.it",
    "molise.it",
    "piedmont.it",
    "piemonte.it",
    "pmn.it",
    "pug.it",
    "puglia.it",
    "sar.it",
    "sardegna.it",
    "sardinia.it",
    "sic.it",
    "sicilia.it",
    "sicily.it",
    "taa.it",
    "tos.it",
    "toscana.it",
    "trentin-sud-tirol.it",
    "trentin-süd-tirol.it",
    "trentin-sudtirol.it",
    "trentin-südtirol.it",
    "trentin-sued-tirol.it",
    "trentin-suedtirol.it",
    "trentino-a-adige.it",
    "trentino-aadige.it",
    "trentino-alto-adige.it",
    "trentino-altoadige.it",
    "trentino-s-tirol.it",
    "trentino-stirol.it",
    "trentino-sud-tirol.it",
    "trentino-süd-tirol.it",
    "trentino-sudtirol.it",
    "trentino-südtirol.it",
    "trentino-sued-tirol.it",
    "trentino-suedtirol.it",
    "trentino.it",
    "trentinoa-adige.it",
    "trentinoaadige.it",
    "trentinoalto-adige.it",
    "trentinoaltoadige.it",
    "trentinos-tirol.it",
    "trentinostirol.it",
    "trentinosud-tirol.it",
    "trentinosüd-tirol.it",
    "trentinosudtirol.it",
    "trentinosüdtirol.it",
    "trentinosued-tirol.it",
    "trentinosuedtirol.it",
    "trentinsud-tirol.it",
    "trentinsüd-tirol.it",
    "trentinsudtirol.it",
    "trentinsüdtirol.it",
    "trentinsued-tirol.it",
    "trentinsuedtirol.it",
    "tuscany.it",
    "umb.it",
    "umbria.it",
    "val-d-aosta.it",
    "val-daosta.it",
    "vald-aosta.it",
    "valdaosta.it",
    "valle-aosta.it",
    "valle-d-aosta.it",
    "valle-daosta.it",
    "valleaosta.it",
    "valled-aosta.it",
    "valledaosta.it",
    "vallee-aoste.it",
    "vallée-aoste.it",
    "vallee-d-aoste.it",
    "vallée-d-aoste.it",
    "valleeaoste.it",
    "valléeaoste.it",
    "valleedaoste.it",
    "valléedaoste.it",
    "vao.it",
    "vda.it",
    "ven.it",
    "veneto.it",
    "ag.it",
    "agrigento.it",
    "al.it",
    "alessandria.it",
    "alto-adige.it",
    "altoadige.it",
    "an.it",
    "ancona.it",
    "andria-barletta-trani.it",
    "andria-trani-barletta.it",
    "andriabarlettatrani.it",
    "andriatranibarletta.it",
    "ao.it",
    "aosta.it",
    "aoste.it",
    "ap.it",
    "aq.it",
    "aquila.it",
    "ar.it",
    "arezzo.it",
    "ascoli-piceno.it",
    "ascolipiceno.it",
    "asti.it",
    "at.it",
    "av.it",
    "avellino.it",
    "ba.it",
    "balsan-sudtirol.it",
    "balsan-südtirol.it",
    "balsan-suedtirol.it",
    "balsan.it",
    "bari.it",
    "barletta-trani-andria.it",
    "barlettatraniandria.it",
    "belluno.it",
    "benevento.it",
    "bergamo.it",
    "bg.it",
    "bi.it",
    "biella.it",
    "bl.it",
    "bn.it",
    "bo.it",
    "bologna.it",
    "bolzano-altoadige.it",
    "bolzano.it",
    "bozen-sudtirol.it",
    "bozen-südtirol.it",
    "bozen-suedtirol.it",
    "bozen.it",
    "br.it",
    "brescia.it",
    "brindisi.it",
    "bs.it",
    "bt.it",
    "bulsan-sudtirol.it",
    "bulsan-südtirol.it",
    "bulsan-suedtirol.it",
    "bulsan.it",
    "bz.it",
    "ca.it",
    "cagliari.it",
    "caltanissetta.it",
    "campidano-medio.it",
    "campidanomedio.it",
    "campobasso.it",
    "carbonia-iglesias.it",
    "carboniaiglesias.it",
    "carrara-massa.it",
    "carraramassa.it",
    "caserta.it",
    "catania.it",
    "catanzaro.it",
    "cb.it",
    "ce.it",
    "cesena-forli.it",
    "cesena-forlì.it",
    "cesenaforli.it",
    "cesenaforlì.it",
    "ch.it",
    "chieti.it",
    "ci.it",
    "cl.it",
    "cn.it",
    "co.it",
    "como.it",
    "cosenza.it",
    "cr.it",
    "cremona.it",
    "crotone.it",
    "cs.it",
    "ct.it",
    "cuneo.it",
    "cz.it",
    "dell-ogliastra.it",
    "dellogliastra.it",
    "en.it",
    "enna.it",
    "fc.it",
    "fe.it",
    "fermo.it",
    "ferrara.it",
    "fg.it",
    "fi.it",
    "firenze.it",
    "florence.it",
    "fm.it",
    "foggia.it",
    "forli-cesena.it",
    "forlì-cesena.it",
    "forlicesena.it",
    "forlìcesena.it",
    "fr.it",
    "frosinone.it",
    "ge.it",
    "genoa.it",
    "genova.it",
    "go.it",
    "gorizia.it",
    "gr.it",
    "grosseto.it",
    "iglesias-carbonia.it",
    "iglesiascarbonia.it",
    "im.it",
    "imperia.it",
    "is.it",
    "isernia.it",
    "kr.it",
    "la-spezia.it",
    "laquila.it",
    "laspezia.it",
    "latina.it",
    "lc.it",
    "le.it",
    "lecce.it",
    "lecco.it",
    "li.it",
    "livorno.it",
    "lo.it",
    "lodi.it",
    "lt.it",
    "lu.it",
    "lucca.it",
    "macerata.it",
    "mantova.it",
    "massa-carrara.it",
    "massacarrara.it",
    "matera.it",
    "mb.it",
    "mc.it",
    "me.it",
    "medio-campidano.it",
    "mediocampidano.it",
    "messina.it",
    "mi.it",
    "milan.it",
    "milano.it",
    "mn.it",
    "mo.it",
    "modena.it",
    "monza-brianza.it",
    "monza-e-della-brianza.it",
    "monza.it",
    "monzabrianza.it",
    "monzaebrianza.it",
    "monzaedellabrianza.it",
    "ms.it",
    "mt.it",
    "na.it",
    "naples.it",
    "napoli.it",
    "no.it",
    "novara.it",
    "nu.it",
    "nuoro.it",
    "og.it",
    "ogliastra.it",
    "olbia-tempio.it",
    "olbiatempio.it",
    "or.it",
    "oristano.it",
    "ot.it",
    "pa.it",
    "padova.it",
    "padua.it",
    "palermo.it",
    "parma.it",
    "pavia.it",
    "pc.it",
    "pd.it",
    "pe.it",
    "perugia.it",
    "pesaro-urbino.it",
    "pesarourbino.it",
    "pescara.it",
    "pg.it",
    "pi.it",
    "piacenza.it",
    "pisa.it",
    "pistoia.it",
    "pn.it",
    "po.it",
    "pordenone.it",
    "potenza.it",
    "pr.it",
    "prato.it",
    "pt.it",
    "pu.it",
    "pv.it",
    "pz.it",
    "ra.it",
    "ragusa.it",
    "ravenna.it",
    "rc.it",
    "re.it",
    "reggio-calabria.it",
    "reggio-emilia.it",
    "reggiocalabria.it",
    "reggioemilia.it",
    "rg.it",
    "ri.it",
    "rieti.it",
    "rimini.it",
    "rm.it",
    "rn.it",
    "ro.it",
    "roma.it",
    "rome.it",
    "rovigo.it",
    "sa.it",
    "salerno.it",
    "sassari.it",
    "savona.it",
    "si.it",
    "siena.it",
    "siracusa.it",
    "so.it",
    "sondrio.it",
    "sp.it",
    "sr.it",
    "ss.it",
    "suedtirol.it",
    "südtirol.it",
    "sv.it",
    "ta.it",
    "taranto.it",
    "te.it",
    "tempio-olbia.it",
    "tempioolbia.it",
    "teramo.it",
    "terni.it",
    "tn.it",
    "to.it",
    "torino.it",
    "tp.it",
    "tr.it",
    "trani-andria-barletta.it",
    "trani-barletta-andria.it",
    "traniandriabarletta.it",
    "tranibarlettaandria.it",
    "trapani.it",
    "trento.it",
    "treviso.it",
    "trieste.it",
    "ts.it",
    "turin.it",
    "tv.it",
    "ud.it",
    "udine.it",
    "urbino-pesaro.it",
    "urbinopesaro.it",
    "va.it",
    "varese.it",
    "vb.it",
    "vc.it",
    "ve.it",
    "venezia.it",
    "venice.it",
    "verbania.it",
    "vercelli.it",
    "verona.it",
    "vi.it",
    "vibo-valentia.it",
    "vibovalentia.it",
    "vicenza.it",
    "viterbo.it",
    "vr.it",
    "vs.it",
    "vt.it",
    "vv.it",
    "je",
    "co.je",
    "net.je",
    "org.je",
    "*.jm",
    "jo",
    "com.jo",
    "org.jo",
    "net.jo",
    "edu.jo",
    "sch.jo",
    "gov.jo",
    "mil.jo",
    "name.jo",
    "jobs",
    "jp",
    "ac.jp",
    "ad.jp",
    "co.jp",
    "ed.jp",
    "go.jp",
    "gr.jp",
    "lg.jp",
    "ne.jp",
    "or.jp",
    "aichi.jp",
    "akita.jp",
    "aomori.jp",
    "chiba.jp",
    "ehime.jp",
    "fukui.jp",
    "fukuoka.jp",
    "fukushima.jp",
    "gifu.jp",
    "gunma.jp",
    "hiroshima.jp",
    "hokkaido.jp",
    "hyogo.jp",
    "ibaraki.jp",
    "ishikawa.jp",
    "iwate.jp",
    "kagawa.jp",
    "kagoshima.jp",
    "kanagawa.jp",
    "kochi.jp",
    "kumamoto.jp",
    "kyoto.jp",
    "mie.jp",
    "miyagi.jp",
    "miyazaki.jp",
    "nagano.jp",
    "nagasaki.jp",
    "nara.jp",
    "niigata.jp",
    "oita.jp",
    "okayama.jp",
    "okinawa.jp",
    "osaka.jp",
    "saga.jp",
    "saitama.jp",
    "shiga.jp",
    "shimane.jp",
    "shizuoka.jp",
    "tochigi.jp",
    "tokushima.jp",
    "tokyo.jp",
    "tottori.jp",
    "toyama.jp",
    "wakayama.jp",
    "yamagata.jp",
    "yamaguchi.jp",
    "yamanashi.jp",
    "栃木.jp",
    "愛知.jp",
    "愛媛.jp",
    "兵庫.jp",
    "熊本.jp",
    "茨城.jp",
    "北海道.jp",
    "千葉.jp",
    "和歌山.jp",
    "長崎.jp",
    "長野.jp",
    "新潟.jp",
    "青森.jp",
    "静岡.jp",
    "東京.jp",
    "石川.jp",
    "埼玉.jp",
    "三重.jp",
    "京都.jp",
    "佐賀.jp",
    "大分.jp",
    "大阪.jp",
    "奈良.jp",
    "宮城.jp",
    "宮崎.jp",
    "富山.jp",
    "山口.jp",
    "山形.jp",
    "山梨.jp",
    "岩手.jp",
    "岐阜.jp",
    "岡山.jp",
    "島根.jp",
    "広島.jp",
    "徳島.jp",
    "沖縄.jp",
    "滋賀.jp",
    "神奈川.jp",
    "福井.jp",
    "福岡.jp",
    "福島.jp",
    "秋田.jp",
    "群馬.jp",
    "香川.jp",
    "高知.jp",
    "鳥取.jp",
    "鹿児島.jp",
    "*.kawasaki.jp",
    "*.kitakyushu.jp",
    "*.kobe.jp",
    "*.nagoya.jp",
    "*.sapporo.jp",
    "*.sendai.jp",
    "*.yokohama.jp",
    "!city.kawasaki.jp",
    "!city.kitakyushu.jp",
    "!city.kobe.jp",
    "!city.nagoya.jp",
    "!city.sapporo.jp",
    "!city.sendai.jp",
    "!city.yokohama.jp",
    "aisai.aichi.jp",
    "ama.aichi.jp",
    "anjo.aichi.jp",
    "asuke.aichi.jp",
    "chiryu.aichi.jp",
    "chita.aichi.jp",
    "fuso.aichi.jp",
    "gamagori.aichi.jp",
    "handa.aichi.jp",
    "hazu.aichi.jp",
    "hekinan.aichi.jp",
    "higashiura.aichi.jp",
    "ichinomiya.aichi.jp",
    "inazawa.aichi.jp",
    "inuyama.aichi.jp",
    "isshiki.aichi.jp",
    "iwakura.aichi.jp",
    "kanie.aichi.jp",
    "kariya.aichi.jp",
    "kasugai.aichi.jp",
    "kira.aichi.jp",
    "kiyosu.aichi.jp",
    "komaki.aichi.jp",
    "konan.aichi.jp",
    "kota.aichi.jp",
    "mihama.aichi.jp",
    "miyoshi.aichi.jp",
    "nishio.aichi.jp",
    "nisshin.aichi.jp",
    "obu.aichi.jp",
    "oguchi.aichi.jp",
    "oharu.aichi.jp",
    "okazaki.aichi.jp",
    "owariasahi.aichi.jp",
    "seto.aichi.jp",
    "shikatsu.aichi.jp",
    "shinshiro.aichi.jp",
    "shitara.aichi.jp",
    "tahara.aichi.jp",
    "takahama.aichi.jp",
    "tobishima.aichi.jp",
    "toei.aichi.jp",
    "togo.aichi.jp",
    "tokai.aichi.jp",
    "tokoname.aichi.jp",
    "toyoake.aichi.jp",
    "toyohashi.aichi.jp",
    "toyokawa.aichi.jp",
    "toyone.aichi.jp",
    "toyota.aichi.jp",
    "tsushima.aichi.jp",
    "yatomi.aichi.jp",
    "akita.akita.jp",
    "daisen.akita.jp",
    "fujisato.akita.jp",
    "gojome.akita.jp",
    "hachirogata.akita.jp",
    "happou.akita.jp",
    "higashinaruse.akita.jp",
    "honjo.akita.jp",
    "honjyo.akita.jp",
    "ikawa.akita.jp",
    "kamikoani.akita.jp",
    "kamioka.akita.jp",
    "katagami.akita.jp",
    "kazuno.akita.jp",
    "kitaakita.akita.jp",
    "kosaka.akita.jp",
    "kyowa.akita.jp",
    "misato.akita.jp",
    "mitane.akita.jp",
    "moriyoshi.akita.jp",
    "nikaho.akita.jp",
    "noshiro.akita.jp",
    "odate.akita.jp",
    "oga.akita.jp",
    "ogata.akita.jp",
    "semboku.akita.jp",
    "yokote.akita.jp",
    "yurihonjo.akita.jp",
    "aomori.aomori.jp",
    "gonohe.aomori.jp",
    "hachinohe.aomori.jp",
    "hashikami.aomori.jp",
    "hiranai.aomori.jp",
    "hirosaki.aomori.jp",
    "itayanagi.aomori.jp",
    "kuroishi.aomori.jp",
    "misawa.aomori.jp",
    "mutsu.aomori.jp",
    "nakadomari.aomori.jp",
    "noheji.aomori.jp",
    "oirase.aomori.jp",
    "owani.aomori.jp",
    "rokunohe.aomori.jp",
    "sannohe.aomori.jp",
    "shichinohe.aomori.jp",
    "shingo.aomori.jp",
    "takko.aomori.jp",
    "towada.aomori.jp",
    "tsugaru.aomori.jp",
    "tsuruta.aomori.jp",
    "abiko.chiba.jp",
    "asahi.chiba.jp",
    "chonan.chiba.jp",
    "chosei.chiba.jp",
    "choshi.chiba.jp",
    "chuo.chiba.jp",
    "funabashi.chiba.jp",
    "futtsu.chiba.jp",
    "hanamigawa.chiba.jp",
    "ichihara.chiba.jp",
    "ichikawa.chiba.jp",
    "ichinomiya.chiba.jp",
    "inzai.chiba.jp",
    "isumi.chiba.jp",
    "kamagaya.chiba.jp",
    "kamogawa.chiba.jp",
    "kashiwa.chiba.jp",
    "katori.chiba.jp",
    "katsuura.chiba.jp",
    "kimitsu.chiba.jp",
    "kisarazu.chiba.jp",
    "kozaki.chiba.jp",
    "kujukuri.chiba.jp",
    "kyonan.chiba.jp",
    "matsudo.chiba.jp",
    "midori.chiba.jp",
    "mihama.chiba.jp",
    "minamiboso.chiba.jp",
    "mobara.chiba.jp",
    "mutsuzawa.chiba.jp",
    "nagara.chiba.jp",
    "nagareyama.chiba.jp",
    "narashino.chiba.jp",
    "narita.chiba.jp",
    "noda.chiba.jp",
    "oamishirasato.chiba.jp",
    "omigawa.chiba.jp",
    "onjuku.chiba.jp",
    "otaki.chiba.jp",
    "sakae.chiba.jp",
    "sakura.chiba.jp",
    "shimofusa.chiba.jp",
    "shirako.chiba.jp",
    "shiroi.chiba.jp",
    "shisui.chiba.jp",
    "sodegaura.chiba.jp",
    "sosa.chiba.jp",
    "tako.chiba.jp",
    "tateyama.chiba.jp",
    "togane.chiba.jp",
    "tohnosho.chiba.jp",
    "tomisato.chiba.jp",
    "urayasu.chiba.jp",
    "yachimata.chiba.jp",
    "yachiyo.chiba.jp",
    "yokaichiba.chiba.jp",
    "yokoshibahikari.chiba.jp",
    "yotsukaido.chiba.jp",
    "ainan.ehime.jp",
    "honai.ehime.jp",
    "ikata.ehime.jp",
    "imabari.ehime.jp",
    "iyo.ehime.jp",
    "kamijima.ehime.jp",
    "kihoku.ehime.jp",
    "kumakogen.ehime.jp",
    "masaki.ehime.jp",
    "matsuno.ehime.jp",
    "matsuyama.ehime.jp",
    "namikata.ehime.jp",
    "niihama.ehime.jp",
    "ozu.ehime.jp",
    "saijo.ehime.jp",
    "seiyo.ehime.jp",
    "shikokuchuo.ehime.jp",
    "tobe.ehime.jp",
    "toon.ehime.jp",
    "uchiko.ehime.jp",
    "uwajima.ehime.jp",
    "yawatahama.ehime.jp",
    "echizen.fukui.jp",
    "eiheiji.fukui.jp",
    "fukui.fukui.jp",
    "ikeda.fukui.jp",
    "katsuyama.fukui.jp",
    "mihama.fukui.jp",
    "minamiechizen.fukui.jp",
    "obama.fukui.jp",
    "ohi.fukui.jp",
    "ono.fukui.jp",
    "sabae.fukui.jp",
    "sakai.fukui.jp",
    "takahama.fukui.jp",
    "tsuruga.fukui.jp",
    "wakasa.fukui.jp",
    "ashiya.fukuoka.jp",
    "buzen.fukuoka.jp",
    "chikugo.fukuoka.jp",
    "chikuho.fukuoka.jp",
    "chikujo.fukuoka.jp",
    "chikushino.fukuoka.jp",
    "chikuzen.fukuoka.jp",
    "chuo.fukuoka.jp",
    "dazaifu.fukuoka.jp",
    "fukuchi.fukuoka.jp",
    "hakata.fukuoka.jp",
    "higashi.fukuoka.jp",
    "hirokawa.fukuoka.jp",
    "hisayama.fukuoka.jp",
    "iizuka.fukuoka.jp",
    "inatsuki.fukuoka.jp",
    "kaho.fukuoka.jp",
    "kasuga.fukuoka.jp",
    "kasuya.fukuoka.jp",
    "kawara.fukuoka.jp",
    "keisen.fukuoka.jp",
    "koga.fukuoka.jp",
    "kurate.fukuoka.jp",
    "kurogi.fukuoka.jp",
    "kurume.fukuoka.jp",
    "minami.fukuoka.jp",
    "miyako.fukuoka.jp",
    "miyama.fukuoka.jp",
    "miyawaka.fukuoka.jp",
    "mizumaki.fukuoka.jp",
    "munakata.fukuoka.jp",
    "nakagawa.fukuoka.jp",
    "nakama.fukuoka.jp",
    "nishi.fukuoka.jp",
    "nogata.fukuoka.jp",
    "ogori.fukuoka.jp",
    "okagaki.fukuoka.jp",
    "okawa.fukuoka.jp",
    "oki.fukuoka.jp",
    "omuta.fukuoka.jp",
    "onga.fukuoka.jp",
    "onojo.fukuoka.jp",
    "oto.fukuoka.jp",
    "saigawa.fukuoka.jp",
    "sasaguri.fukuoka.jp",
    "shingu.fukuoka.jp",
    "shinyoshitomi.fukuoka.jp",
    "shonai.fukuoka.jp",
    "soeda.fukuoka.jp",
    "sue.fukuoka.jp",
    "tachiarai.fukuoka.jp",
    "tagawa.fukuoka.jp",
    "takata.fukuoka.jp",
    "toho.fukuoka.jp",
    "toyotsu.fukuoka.jp",
    "tsuiki.fukuoka.jp",
    "ukiha.fukuoka.jp",
    "umi.fukuoka.jp",
    "usui.fukuoka.jp",
    "yamada.fukuoka.jp",
    "yame.fukuoka.jp",
    "yanagawa.fukuoka.jp",
    "yukuhashi.fukuoka.jp",
    "aizubange.fukushima.jp",
    "aizumisato.fukushima.jp",
    "aizuwakamatsu.fukushima.jp",
    "asakawa.fukushima.jp",
    "bandai.fukushima.jp",
    "date.fukushima.jp",
    "fukushima.fukushima.jp",
    "furudono.fukushima.jp",
    "futaba.fukushima.jp",
    "hanawa.fukushima.jp",
    "higashi.fukushima.jp",
    "hirata.fukushima.jp",
    "hirono.fukushima.jp",
    "iitate.fukushima.jp",
    "inawashiro.fukushima.jp",
    "ishikawa.fukushima.jp",
    "iwaki.fukushima.jp",
    "izumizaki.fukushima.jp",
    "kagamiishi.fukushima.jp",
    "kaneyama.fukushima.jp",
    "kawamata.fukushima.jp",
    "kitakata.fukushima.jp",
    "kitashiobara.fukushima.jp",
    "koori.fukushima.jp",
    "koriyama.fukushima.jp",
    "kunimi.fukushima.jp",
    "miharu.fukushima.jp",
    "mishima.fukushima.jp",
    "namie.fukushima.jp",
    "nango.fukushima.jp",
    "nishiaizu.fukushima.jp",
    "nishigo.fukushima.jp",
    "okuma.fukushima.jp",
    "omotego.fukushima.jp",
    "ono.fukushima.jp",
    "otama.fukushima.jp",
    "samegawa.fukushima.jp",
    "shimogo.fukushima.jp",
    "shirakawa.fukushima.jp",
    "showa.fukushima.jp",
    "soma.fukushima.jp",
    "sukagawa.fukushima.jp",
    "taishin.fukushima.jp",
    "tamakawa.fukushima.jp",
    "tanagura.fukushima.jp",
    "tenei.fukushima.jp",
    "yabuki.fukushima.jp",
    "yamato.fukushima.jp",
    "yamatsuri.fukushima.jp",
    "yanaizu.fukushima.jp",
    "yugawa.fukushima.jp",
    "anpachi.gifu.jp",
    "ena.gifu.jp",
    "gifu.gifu.jp",
    "ginan.gifu.jp",
    "godo.gifu.jp",
    "gujo.gifu.jp",
    "hashima.gifu.jp",
    "hichiso.gifu.jp",
    "hida.gifu.jp",
    "higashishirakawa.gifu.jp",
    "ibigawa.gifu.jp",
    "ikeda.gifu.jp",
    "kakamigahara.gifu.jp",
    "kani.gifu.jp",
    "kasahara.gifu.jp",
    "kasamatsu.gifu.jp",
    "kawaue.gifu.jp",
    "kitagata.gifu.jp",
    "mino.gifu.jp",
    "minokamo.gifu.jp",
    "mitake.gifu.jp",
    "mizunami.gifu.jp",
    "motosu.gifu.jp",
    "nakatsugawa.gifu.jp",
    "ogaki.gifu.jp",
    "sakahogi.gifu.jp",
    "seki.gifu.jp",
    "sekigahara.gifu.jp",
    "shirakawa.gifu.jp",
    "tajimi.gifu.jp",
    "takayama.gifu.jp",
    "tarui.gifu.jp",
    "toki.gifu.jp",
    "tomika.gifu.jp",
    "wanouchi.gifu.jp",
    "yamagata.gifu.jp",
    "yaotsu.gifu.jp",
    "yoro.gifu.jp",
    "annaka.gunma.jp",
    "chiyoda.gunma.jp",
    "fujioka.gunma.jp",
    "higashiagatsuma.gunma.jp",
    "isesaki.gunma.jp",
    "itakura.gunma.jp",
    "kanna.gunma.jp",
    "kanra.gunma.jp",
    "katashina.gunma.jp",
    "kawaba.gunma.jp",
    "kiryu.gunma.jp",
    "kusatsu.gunma.jp",
    "maebashi.gunma.jp",
    "meiwa.gunma.jp",
    "midori.gunma.jp",
    "minakami.gunma.jp",
    "naganohara.gunma.jp",
    "nakanojo.gunma.jp",
    "nanmoku.gunma.jp",
    "numata.gunma.jp",
    "oizumi.gunma.jp",
    "ora.gunma.jp",
    "ota.gunma.jp",
    "shibukawa.gunma.jp",
    "shimonita.gunma.jp",
    "shinto.gunma.jp",
    "showa.gunma.jp",
    "takasaki.gunma.jp",
    "takayama.gunma.jp",
    "tamamura.gunma.jp",
    "tatebayashi.gunma.jp",
    "tomioka.gunma.jp",
    "tsukiyono.gunma.jp",
    "tsumagoi.gunma.jp",
    "ueno.gunma.jp",
    "yoshioka.gunma.jp",
    "asaminami.hiroshima.jp",
    "daiwa.hiroshima.jp",
    "etajima.hiroshima.jp",
    "fuchu.hiroshima.jp",
    "fukuyama.hiroshima.jp",
    "hatsukaichi.hiroshima.jp",
    "higashihiroshima.hiroshima.jp",
    "hongo.hiroshima.jp",
    "jinsekikogen.hiroshima.jp",
    "kaita.hiroshima.jp",
    "kui.hiroshima.jp",
    "kumano.hiroshima.jp",
    "kure.hiroshima.jp",
    "mihara.hiroshima.jp",
    "miyoshi.hiroshima.jp",
    "naka.hiroshima.jp",
    "onomichi.hiroshima.jp",
    "osakikamijima.hiroshima.jp",
    "otake.hiroshima.jp",
    "saka.hiroshima.jp",
    "sera.hiroshima.jp",
    "seranishi.hiroshima.jp",
    "shinichi.hiroshima.jp",
    "shobara.hiroshima.jp",
    "takehara.hiroshima.jp",
    "abashiri.hokkaido.jp",
    "abira.hokkaido.jp",
    "aibetsu.hokkaido.jp",
    "akabira.hokkaido.jp",
    "akkeshi.hokkaido.jp",
    "asahikawa.hokkaido.jp",
    "ashibetsu.hokkaido.jp",
    "ashoro.hokkaido.jp",
    "assabu.hokkaido.jp",
    "atsuma.hokkaido.jp",
    "bibai.hokkaido.jp",
    "biei.hokkaido.jp",
    "bifuka.hokkaido.jp",
    "bihoro.hokkaido.jp",
    "biratori.hokkaido.jp",
    "chippubetsu.hokkaido.jp",
    "chitose.hokkaido.jp",
    "date.hokkaido.jp",
    "ebetsu.hokkaido.jp",
    "embetsu.hokkaido.jp",
    "eniwa.hokkaido.jp",
    "erimo.hokkaido.jp",
    "esan.hokkaido.jp",
    "esashi.hokkaido.jp",
    "fukagawa.hokkaido.jp",
    "fukushima.hokkaido.jp",
    "furano.hokkaido.jp",
    "furubira.hokkaido.jp",
    "haboro.hokkaido.jp",
    "hakodate.hokkaido.jp",
    "hamatonbetsu.hokkaido.jp",
    "hidaka.hokkaido.jp",
    "higashikagura.hokkaido.jp",
    "higashikawa.hokkaido.jp",
    "hiroo.hokkaido.jp",
    "hokuryu.hokkaido.jp",
    "hokuto.hokkaido.jp",
    "honbetsu.hokkaido.jp",
    "horokanai.hokkaido.jp",
    "horonobe.hokkaido.jp",
    "ikeda.hokkaido.jp",
    "imakane.hokkaido.jp",
    "ishikari.hokkaido.jp",
    "iwamizawa.hokkaido.jp",
    "iwanai.hokkaido.jp",
    "kamifurano.hokkaido.jp",
    "kamikawa.hokkaido.jp",
    "kamishihoro.hokkaido.jp",
    "kamisunagawa.hokkaido.jp",
    "kamoenai.hokkaido.jp",
    "kayabe.hokkaido.jp",
    "kembuchi.hokkaido.jp",
    "kikonai.hokkaido.jp",
    "kimobetsu.hokkaido.jp",
    "kitahiroshima.hokkaido.jp",
    "kitami.hokkaido.jp",
    "kiyosato.hokkaido.jp",
    "koshimizu.hokkaido.jp",
    "kunneppu.hokkaido.jp",
    "kuriyama.hokkaido.jp",
    "kuromatsunai.hokkaido.jp",
    "kushiro.hokkaido.jp",
    "kutchan.hokkaido.jp",
    "kyowa.hokkaido.jp",
    "mashike.hokkaido.jp",
    "matsumae.hokkaido.jp",
    "mikasa.hokkaido.jp",
    "minamifurano.hokkaido.jp",
    "mombetsu.hokkaido.jp",
    "moseushi.hokkaido.jp",
    "mukawa.hokkaido.jp",
    "muroran.hokkaido.jp",
    "naie.hokkaido.jp",
    "nakagawa.hokkaido.jp",
    "nakasatsunai.hokkaido.jp",
    "nakatombetsu.hokkaido.jp",
    "nanae.hokkaido.jp",
    "nanporo.hokkaido.jp",
    "nayoro.hokkaido.jp",
    "nemuro.hokkaido.jp",
    "niikappu.hokkaido.jp",
    "niki.hokkaido.jp",
    "nishiokoppe.hokkaido.jp",
    "noboribetsu.hokkaido.jp",
    "numata.hokkaido.jp",
    "obihiro.hokkaido.jp",
    "obira.hokkaido.jp",
    "oketo.hokkaido.jp",
    "okoppe.hokkaido.jp",
    "otaru.hokkaido.jp",
    "otobe.hokkaido.jp",
    "otofuke.hokkaido.jp",
    "otoineppu.hokkaido.jp",
    "oumu.hokkaido.jp",
    "ozora.hokkaido.jp",
    "pippu.hokkaido.jp",
    "rankoshi.hokkaido.jp",
    "rebun.hokkaido.jp",
    "rikubetsu.hokkaido.jp",
    "rishiri.hokkaido.jp",
    "rishirifuji.hokkaido.jp",
    "saroma.hokkaido.jp",
    "sarufutsu.hokkaido.jp",
    "shakotan.hokkaido.jp",
    "shari.hokkaido.jp",
    "shibecha.hokkaido.jp",
    "shibetsu.hokkaido.jp",
    "shikabe.hokkaido.jp",
    "shikaoi.hokkaido.jp",
    "shimamaki.hokkaido.jp",
    "shimizu.hokkaido.jp",
    "shimokawa.hokkaido.jp",
    "shinshinotsu.hokkaido.jp",
    "shintoku.hokkaido.jp",
    "shiranuka.hokkaido.jp",
    "shiraoi.hokkaido.jp",
    "shiriuchi.hokkaido.jp",
    "sobetsu.hokkaido.jp",
    "sunagawa.hokkaido.jp",
    "taiki.hokkaido.jp",
    "takasu.hokkaido.jp",
    "takikawa.hokkaido.jp",
    "takinoue.hokkaido.jp",
    "teshikaga.hokkaido.jp",
    "tobetsu.hokkaido.jp",
    "tohma.hokkaido.jp",
    "tomakomai.hokkaido.jp",
    "tomari.hokkaido.jp",
    "toya.hokkaido.jp",
    "toyako.hokkaido.jp",
    "toyotomi.hokkaido.jp",
    "toyoura.hokkaido.jp",
    "tsubetsu.hokkaido.jp",
    "tsukigata.hokkaido.jp",
    "urakawa.hokkaido.jp",
    "urausu.hokkaido.jp",
    "uryu.hokkaido.jp",
    "utashinai.hokkaido.jp",
    "wakkanai.hokkaido.jp",
    "wassamu.hokkaido.jp",
    "yakumo.hokkaido.jp",
    "yoichi.hokkaido.jp",
    "aioi.hyogo.jp",
    "akashi.hyogo.jp",
    "ako.hyogo.jp",
    "amagasaki.hyogo.jp",
    "aogaki.hyogo.jp",
    "asago.hyogo.jp",
    "ashiya.hyogo.jp",
    "awaji.hyogo.jp",
    "fukusaki.hyogo.jp",
    "goshiki.hyogo.jp",
    "harima.hyogo.jp",
    "himeji.hyogo.jp",
    "ichikawa.hyogo.jp",
    "inagawa.hyogo.jp",
    "itami.hyogo.jp",
    "kakogawa.hyogo.jp",
    "kamigori.hyogo.jp",
    "kamikawa.hyogo.jp",
    "kasai.hyogo.jp",
    "kasuga.hyogo.jp",
    "kawanishi.hyogo.jp",
    "miki.hyogo.jp",
    "minamiawaji.hyogo.jp",
    "nishinomiya.hyogo.jp",
    "nishiwaki.hyogo.jp",
    "ono.hyogo.jp",
    "sanda.hyogo.jp",
    "sannan.hyogo.jp",
    "sasayama.hyogo.jp",
    "sayo.hyogo.jp",
    "shingu.hyogo.jp",
    "shinonsen.hyogo.jp",
    "shiso.hyogo.jp",
    "sumoto.hyogo.jp",
    "taishi.hyogo.jp",
    "taka.hyogo.jp",
    "takarazuka.hyogo.jp",
    "takasago.hyogo.jp",
    "takino.hyogo.jp",
    "tamba.hyogo.jp",
    "tatsuno.hyogo.jp",
    "toyooka.hyogo.jp",
    "yabu.hyogo.jp",
    "yashiro.hyogo.jp",
    "yoka.hyogo.jp",
    "yokawa.hyogo.jp",
    "ami.ibaraki.jp",
    "asahi.ibaraki.jp",
    "bando.ibaraki.jp",
    "chikusei.ibaraki.jp",
    "daigo.ibaraki.jp",
    "fujishiro.ibaraki.jp",
    "hitachi.ibaraki.jp",
    "hitachinaka.ibaraki.jp",
    "hitachiomiya.ibaraki.jp",
    "hitachiota.ibaraki.jp",
    "ibaraki.ibaraki.jp",
    "ina.ibaraki.jp",
    "inashiki.ibaraki.jp",
    "itako.ibaraki.jp",
    "iwama.ibaraki.jp",
    "joso.ibaraki.jp",
    "kamisu.ibaraki.jp",
    "kasama.ibaraki.jp",
    "kashima.ibaraki.jp",
    "kasumigaura.ibaraki.jp",
    "koga.ibaraki.jp",
    "miho.ibaraki.jp",
    "mito.ibaraki.jp",
    "moriya.ibaraki.jp",
    "naka.ibaraki.jp",
    "namegata.ibaraki.jp",
    "oarai.ibaraki.jp",
    "ogawa.ibaraki.jp",
    "omitama.ibaraki.jp",
    "ryugasaki.ibaraki.jp",
    "sakai.ibaraki.jp",
    "sakuragawa.ibaraki.jp",
    "shimodate.ibaraki.jp",
    "shimotsuma.ibaraki.jp",
    "shirosato.ibaraki.jp",
    "sowa.ibaraki.jp",
    "suifu.ibaraki.jp",
    "takahagi.ibaraki.jp",
    "tamatsukuri.ibaraki.jp",
    "tokai.ibaraki.jp",
    "tomobe.ibaraki.jp",
    "tone.ibaraki.jp",
    "toride.ibaraki.jp",
    "tsuchiura.ibaraki.jp",
    "tsukuba.ibaraki.jp",
    "uchihara.ibaraki.jp",
    "ushiku.ibaraki.jp",
    "yachiyo.ibaraki.jp",
    "yamagata.ibaraki.jp",
    "yawara.ibaraki.jp",
    "yuki.ibaraki.jp",
    "anamizu.ishikawa.jp",
    "hakui.ishikawa.jp",
    "hakusan.ishikawa.jp",
    "kaga.ishikawa.jp",
    "kahoku.ishikawa.jp",
    "kanazawa.ishikawa.jp",
    "kawakita.ishikawa.jp",
    "komatsu.ishikawa.jp",
    "nakanoto.ishikawa.jp",
    "nanao.ishikawa.jp",
    "nomi.ishikawa.jp",
    "nonoichi.ishikawa.jp",
    "noto.ishikawa.jp",
    "shika.ishikawa.jp",
    "suzu.ishikawa.jp",
    "tsubata.ishikawa.jp",
    "tsurugi.ishikawa.jp",
    "uchinada.ishikawa.jp",
    "wajima.ishikawa.jp",
    "fudai.iwate.jp",
    "fujisawa.iwate.jp",
    "hanamaki.iwate.jp",
    "hiraizumi.iwate.jp",
    "hirono.iwate.jp",
    "ichinohe.iwate.jp",
    "ichinoseki.iwate.jp",
    "iwaizumi.iwate.jp",
    "iwate.iwate.jp",
    "joboji.iwate.jp",
    "kamaishi.iwate.jp",
    "kanegasaki.iwate.jp",
    "karumai.iwate.jp",
    "kawai.iwate.jp",
    "kitakami.iwate.jp",
    "kuji.iwate.jp",
    "kunohe.iwate.jp",
    "kuzumaki.iwate.jp",
    "miyako.iwate.jp",
    "mizusawa.iwate.jp",
    "morioka.iwate.jp",
    "ninohe.iwate.jp",
    "noda.iwate.jp",
    "ofunato.iwate.jp",
    "oshu.iwate.jp",
    "otsuchi.iwate.jp",
    "rikuzentakata.iwate.jp",
    "shiwa.iwate.jp",
    "shizukuishi.iwate.jp",
    "sumita.iwate.jp",
    "tanohata.iwate.jp",
    "tono.iwate.jp",
    "yahaba.iwate.jp",
    "yamada.iwate.jp",
    "ayagawa.kagawa.jp",
    "higashikagawa.kagawa.jp",
    "kanonji.kagawa.jp",
    "kotohira.kagawa.jp",
    "manno.kagawa.jp",
    "marugame.kagawa.jp",
    "mitoyo.kagawa.jp",
    "naoshima.kagawa.jp",
    "sanuki.kagawa.jp",
    "tadotsu.kagawa.jp",
    "takamatsu.kagawa.jp",
    "tonosho.kagawa.jp",
    "uchinomi.kagawa.jp",
    "utazu.kagawa.jp",
    "zentsuji.kagawa.jp",
    "akune.kagoshima.jp",
    "amami.kagoshima.jp",
    "hioki.kagoshima.jp",
    "isa.kagoshima.jp",
    "isen.kagoshima.jp",
    "izumi.kagoshima.jp",
    "kagoshima.kagoshima.jp",
    "kanoya.kagoshima.jp",
    "kawanabe.kagoshima.jp",
    "kinko.kagoshima.jp",
    "kouyama.kagoshima.jp",
    "makurazaki.kagoshima.jp",
    "matsumoto.kagoshima.jp",
    "minamitane.kagoshima.jp",
    "nakatane.kagoshima.jp",
    "nishinoomote.kagoshima.jp",
    "satsumasendai.kagoshima.jp",
    "soo.kagoshima.jp",
    "tarumizu.kagoshima.jp",
    "yusui.kagoshima.jp",
    "aikawa.kanagawa.jp",
    "atsugi.kanagawa.jp",
    "ayase.kanagawa.jp",
    "chigasaki.kanagawa.jp",
    "ebina.kanagawa.jp",
    "fujisawa.kanagawa.jp",
    "hadano.kanagawa.jp",
    "hakone.kanagawa.jp",
    "hiratsuka.kanagawa.jp",
    "isehara.kanagawa.jp",
    "kaisei.kanagawa.jp",
    "kamakura.kanagawa.jp",
    "kiyokawa.kanagawa.jp",
    "matsuda.kanagawa.jp",
    "minamiashigara.kanagawa.jp",
    "miura.kanagawa.jp",
    "nakai.kanagawa.jp",
    "ninomiya.kanagawa.jp",
    "odawara.kanagawa.jp",
    "oi.kanagawa.jp",
    "oiso.kanagawa.jp",
    "sagamihara.kanagawa.jp",
    "samukawa.kanagawa.jp",
    "tsukui.kanagawa.jp",
    "yamakita.kanagawa.jp",
    "yamato.kanagawa.jp",
    "yokosuka.kanagawa.jp",
    "yugawara.kanagawa.jp",
    "zama.kanagawa.jp",
    "zushi.kanagawa.jp",
    "aki.kochi.jp",
    "geisei.kochi.jp",
    "hidaka.kochi.jp",
    "higashitsuno.kochi.jp",
    "ino.kochi.jp",
    "kagami.kochi.jp",
    "kami.kochi.jp",
    "kitagawa.kochi.jp",
    "kochi.kochi.jp",
    "mihara.kochi.jp",
    "motoyama.kochi.jp",
    "muroto.kochi.jp",
    "nahari.kochi.jp",
    "nakamura.kochi.jp",
    "nankoku.kochi.jp",
    "nishitosa.kochi.jp",
    "niyodogawa.kochi.jp",
    "ochi.kochi.jp",
    "okawa.kochi.jp",
    "otoyo.kochi.jp",
    "otsuki.kochi.jp",
    "sakawa.kochi.jp",
    "sukumo.kochi.jp",
    "susaki.kochi.jp",
    "tosa.kochi.jp",
    "tosashimizu.kochi.jp",
    "toyo.kochi.jp",
    "tsuno.kochi.jp",
    "umaji.kochi.jp",
    "yasuda.kochi.jp",
    "yusuhara.kochi.jp",
    "amakusa.kumamoto.jp",
    "arao.kumamoto.jp",
    "aso.kumamoto.jp",
    "choyo.kumamoto.jp",
    "gyokuto.kumamoto.jp",
    "kamiamakusa.kumamoto.jp",
    "kikuchi.kumamoto.jp",
    "kumamoto.kumamoto.jp",
    "mashiki.kumamoto.jp",
    "mifune.kumamoto.jp",
    "minamata.kumamoto.jp",
    "minamioguni.kumamoto.jp",
    "nagasu.kumamoto.jp",
    "nishihara.kumamoto.jp",
    "oguni.kumamoto.jp",
    "ozu.kumamoto.jp",
    "sumoto.kumamoto.jp",
    "takamori.kumamoto.jp",
    "uki.kumamoto.jp",
    "uto.kumamoto.jp",
    "yamaga.kumamoto.jp",
    "yamato.kumamoto.jp",
    "yatsushiro.kumamoto.jp",
    "ayabe.kyoto.jp",
    "fukuchiyama.kyoto.jp",
    "higashiyama.kyoto.jp",
    "ide.kyoto.jp",
    "ine.kyoto.jp",
    "joyo.kyoto.jp",
    "kameoka.kyoto.jp",
    "kamo.kyoto.jp",
    "kita.kyoto.jp",
    "kizu.kyoto.jp",
    "kumiyama.kyoto.jp",
    "kyotamba.kyoto.jp",
    "kyotanabe.kyoto.jp",
    "kyotango.kyoto.jp",
    "maizuru.kyoto.jp",
    "minami.kyoto.jp",
    "minamiyamashiro.kyoto.jp",
    "miyazu.kyoto.jp",
    "muko.kyoto.jp",
    "nagaokakyo.kyoto.jp",
    "nakagyo.kyoto.jp",
    "nantan.kyoto.jp",
    "oyamazaki.kyoto.jp",
    "sakyo.kyoto.jp",
    "seika.kyoto.jp",
    "tanabe.kyoto.jp",
    "uji.kyoto.jp",
    "ujitawara.kyoto.jp",
    "wazuka.kyoto.jp",
    "yamashina.kyoto.jp",
    "yawata.kyoto.jp",
    "asahi.mie.jp",
    "inabe.mie.jp",
    "ise.mie.jp",
    "kameyama.mie.jp",
    "kawagoe.mie.jp",
    "kiho.mie.jp",
    "kisosaki.mie.jp",
    "kiwa.mie.jp",
    "komono.mie.jp",
    "kumano.mie.jp",
    "kuwana.mie.jp",
    "matsusaka.mie.jp",
    "meiwa.mie.jp",
    "mihama.mie.jp",
    "minamiise.mie.jp",
    "misugi.mie.jp",
    "miyama.mie.jp",
    "nabari.mie.jp",
    "shima.mie.jp",
    "suzuka.mie.jp",
    "tado.mie.jp",
    "taiki.mie.jp",
    "taki.mie.jp",
    "tamaki.mie.jp",
    "toba.mie.jp",
    "tsu.mie.jp",
    "udono.mie.jp",
    "ureshino.mie.jp",
    "watarai.mie.jp",
    "yokkaichi.mie.jp",
    "furukawa.miyagi.jp",
    "higashimatsushima.miyagi.jp",
    "ishinomaki.miyagi.jp",
    "iwanuma.miyagi.jp",
    "kakuda.miyagi.jp",
    "kami.miyagi.jp",
    "kawasaki.miyagi.jp",
    "marumori.miyagi.jp",
    "matsushima.miyagi.jp",
    "minamisanriku.miyagi.jp",
    "misato.miyagi.jp",
    "murata.miyagi.jp",
    "natori.miyagi.jp",
    "ogawara.miyagi.jp",
    "ohira.miyagi.jp",
    "onagawa.miyagi.jp",
    "osaki.miyagi.jp",
    "rifu.miyagi.jp",
    "semine.miyagi.jp",
    "shibata.miyagi.jp",
    "shichikashuku.miyagi.jp",
    "shikama.miyagi.jp",
    "shiogama.miyagi.jp",
    "shiroishi.miyagi.jp",
    "tagajo.miyagi.jp",
    "taiwa.miyagi.jp",
    "tome.miyagi.jp",
    "tomiya.miyagi.jp",
    "wakuya.miyagi.jp",
    "watari.miyagi.jp",
    "yamamoto.miyagi.jp",
    "zao.miyagi.jp",
    "aya.miyazaki.jp",
    "ebino.miyazaki.jp",
    "gokase.miyazaki.jp",
    "hyuga.miyazaki.jp",
    "kadogawa.miyazaki.jp",
    "kawaminami.miyazaki.jp",
    "kijo.miyazaki.jp",
    "kitagawa.miyazaki.jp",
    "kitakata.miyazaki.jp",
    "kitaura.miyazaki.jp",
    "kobayashi.miyazaki.jp",
    "kunitomi.miyazaki.jp",
    "kushima.miyazaki.jp",
    "mimata.miyazaki.jp",
    "miyakonojo.miyazaki.jp",
    "miyazaki.miyazaki.jp",
    "morotsuka.miyazaki.jp",
    "nichinan.miyazaki.jp",
    "nishimera.miyazaki.jp",
    "nobeoka.miyazaki.jp",
    "saito.miyazaki.jp",
    "shiiba.miyazaki.jp",
    "shintomi.miyazaki.jp",
    "takaharu.miyazaki.jp",
    "takanabe.miyazaki.jp",
    "takazaki.miyazaki.jp",
    "tsuno.miyazaki.jp",
    "achi.nagano.jp",
    "agematsu.nagano.jp",
    "anan.nagano.jp",
    "aoki.nagano.jp",
    "asahi.nagano.jp",
    "azumino.nagano.jp",
    "chikuhoku.nagano.jp",
    "chikuma.nagano.jp",
    "chino.nagano.jp",
    "fujimi.nagano.jp",
    "hakuba.nagano.jp",
    "hara.nagano.jp",
    "hiraya.nagano.jp",
    "iida.nagano.jp",
    "iijima.nagano.jp",
    "iiyama.nagano.jp",
    "iizuna.nagano.jp",
    "ikeda.nagano.jp",
    "ikusaka.nagano.jp",
    "ina.nagano.jp",
    "karuizawa.nagano.jp",
    "kawakami.nagano.jp",
    "kiso.nagano.jp",
    "kisofukushima.nagano.jp",
    "kitaaiki.nagano.jp",
    "komagane.nagano.jp",
    "komoro.nagano.jp",
    "matsukawa.nagano.jp",
    "matsumoto.nagano.jp",
    "miasa.nagano.jp",
    "minamiaiki.nagano.jp",
    "minamimaki.nagano.jp",
    "minamiminowa.nagano.jp",
    "minowa.nagano.jp",
    "miyada.nagano.jp",
    "miyota.nagano.jp",
    "mochizuki.nagano.jp",
    "nagano.nagano.jp",
    "nagawa.nagano.jp",
    "nagiso.nagano.jp",
    "nakagawa.nagano.jp",
    "nakano.nagano.jp",
    "nozawaonsen.nagano.jp",
    "obuse.nagano.jp",
    "ogawa.nagano.jp",
    "okaya.nagano.jp",
    "omachi.nagano.jp",
    "omi.nagano.jp",
    "ookuwa.nagano.jp",
    "ooshika.nagano.jp",
    "otaki.nagano.jp",
    "otari.nagano.jp",
    "sakae.nagano.jp",
    "sakaki.nagano.jp",
    "saku.nagano.jp",
    "sakuho.nagano.jp",
    "shimosuwa.nagano.jp",
    "shinanomachi.nagano.jp",
    "shiojiri.nagano.jp",
    "suwa.nagano.jp",
    "suzaka.nagano.jp",
    "takagi.nagano.jp",
    "takamori.nagano.jp",
    "takayama.nagano.jp",
    "tateshina.nagano.jp",
    "tatsuno.nagano.jp",
    "togakushi.nagano.jp",
    "togura.nagano.jp",
    "tomi.nagano.jp",
    "ueda.nagano.jp",
    "wada.nagano.jp",
    "yamagata.nagano.jp",
    "yamanouchi.nagano.jp",
    "yasaka.nagano.jp",
    "yasuoka.nagano.jp",
    "chijiwa.nagasaki.jp",
    "futsu.nagasaki.jp",
    "goto.nagasaki.jp",
    "hasami.nagasaki.jp",
    "hirado.nagasaki.jp",
    "iki.nagasaki.jp",
    "isahaya.nagasaki.jp",
    "kawatana.nagasaki.jp",
    "kuchinotsu.nagasaki.jp",
    "matsuura.nagasaki.jp",
    "nagasaki.nagasaki.jp",
    "obama.nagasaki.jp",
    "omura.nagasaki.jp",
    "oseto.nagasaki.jp",
    "saikai.nagasaki.jp",
    "sasebo.nagasaki.jp",
    "seihi.nagasaki.jp",
    "shimabara.nagasaki.jp",
    "shinkamigoto.nagasaki.jp",
    "togitsu.nagasaki.jp",
    "tsushima.nagasaki.jp",
    "unzen.nagasaki.jp",
    "ando.nara.jp",
    "gose.nara.jp",
    "heguri.nara.jp",
    "higashiyoshino.nara.jp",
    "ikaruga.nara.jp",
    "ikoma.nara.jp",
    "kamikitayama.nara.jp",
    "kanmaki.nara.jp",
    "kashiba.nara.jp",
    "kashihara.nara.jp",
    "katsuragi.nara.jp",
    "kawai.nara.jp",
    "kawakami.nara.jp",
    "kawanishi.nara.jp",
    "koryo.nara.jp",
    "kurotaki.nara.jp",
    "mitsue.nara.jp",
    "miyake.nara.jp",
    "nara.nara.jp",
    "nosegawa.nara.jp",
    "oji.nara.jp",
    "ouda.nara.jp",
    "oyodo.nara.jp",
    "sakurai.nara.jp",
    "sango.nara.jp",
    "shimoichi.nara.jp",
    "shimokitayama.nara.jp",
    "shinjo.nara.jp",
    "soni.nara.jp",
    "takatori.nara.jp",
    "tawaramoto.nara.jp",
    "tenkawa.nara.jp",
    "tenri.nara.jp",
    "uda.nara.jp",
    "yamatokoriyama.nara.jp",
    "yamatotakada.nara.jp",
    "yamazoe.nara.jp",
    "yoshino.nara.jp",
    "aga.niigata.jp",
    "agano.niigata.jp",
    "gosen.niigata.jp",
    "itoigawa.niigata.jp",
    "izumozaki.niigata.jp",
    "joetsu.niigata.jp",
    "kamo.niigata.jp",
    "kariwa.niigata.jp",
    "kashiwazaki.niigata.jp",
    "minamiuonuma.niigata.jp",
    "mitsuke.niigata.jp",
    "muika.niigata.jp",
    "murakami.niigata.jp",
    "myoko.niigata.jp",
    "nagaoka.niigata.jp",
    "niigata.niigata.jp",
    "ojiya.niigata.jp",
    "omi.niigata.jp",
    "sado.niigata.jp",
    "sanjo.niigata.jp",
    "seiro.niigata.jp",
    "seirou.niigata.jp",
    "sekikawa.niigata.jp",
    "shibata.niigata.jp",
    "tagami.niigata.jp",
    "tainai.niigata.jp",
    "tochio.niigata.jp",
    "tokamachi.niigata.jp",
    "tsubame.niigata.jp",
    "tsunan.niigata.jp",
    "uonuma.niigata.jp",
    "yahiko.niigata.jp",
    "yoita.niigata.jp",
    "yuzawa.niigata.jp",
    "beppu.oita.jp",
    "bungoono.oita.jp",
    "bungotakada.oita.jp",
    "hasama.oita.jp",
    "hiji.oita.jp",
    "himeshima.oita.jp",
    "hita.oita.jp",
    "kamitsue.oita.jp",
    "kokonoe.oita.jp",
    "kuju.oita.jp",
    "kunisaki.oita.jp",
    "kusu.oita.jp",
    "oita.oita.jp",
    "saiki.oita.jp",
    "taketa.oita.jp",
    "tsukumi.oita.jp",
    "usa.oita.jp",
    "usuki.oita.jp",
    "yufu.oita.jp",
    "akaiwa.okayama.jp",
    "asakuchi.okayama.jp",
    "bizen.okayama.jp",
    "hayashima.okayama.jp",
    "ibara.okayama.jp",
    "kagamino.okayama.jp",
    "kasaoka.okayama.jp",
    "kibichuo.okayama.jp",
    "kumenan.okayama.jp",
    "kurashiki.okayama.jp",
    "maniwa.okayama.jp",
    "misaki.okayama.jp",
    "nagi.okayama.jp",
    "niimi.okayama.jp",
    "nishiawakura.okayama.jp",
    "okayama.okayama.jp",
    "satosho.okayama.jp",
    "setouchi.okayama.jp",
    "shinjo.okayama.jp",
    "shoo.okayama.jp",
    "soja.okayama.jp",
    "takahashi.okayama.jp",
    "tamano.okayama.jp",
    "tsuyama.okayama.jp",
    "wake.okayama.jp",
    "yakage.okayama.jp",
    "aguni.okinawa.jp",
    "ginowan.okinawa.jp",
    "ginoza.okinawa.jp",
    "gushikami.okinawa.jp",
    "haebaru.okinawa.jp",
    "higashi.okinawa.jp",
    "hirara.okinawa.jp",
    "iheya.okinawa.jp",
    "ishigaki.okinawa.jp",
    "ishikawa.okinawa.jp",
    "itoman.okinawa.jp",
    "izena.okinawa.jp",
    "kadena.okinawa.jp",
    "kin.okinawa.jp",
    "kitadaito.okinawa.jp",
    "kitanakagusuku.okinawa.jp",
    "kumejima.okinawa.jp",
    "kunigami.okinawa.jp",
    "minamidaito.okinawa.jp",
    "motobu.okinawa.jp",
    "nago.okinawa.jp",
    "naha.okinawa.jp",
    "nakagusuku.okinawa.jp",
    "nakijin.okinawa.jp",
    "nanjo.okinawa.jp",
    "nishihara.okinawa.jp",
    "ogimi.okinawa.jp",
    "okinawa.okinawa.jp",
    "onna.okinawa.jp",
    "shimoji.okinawa.jp",
    "taketomi.okinawa.jp",
    "tarama.okinawa.jp",
    "tokashiki.okinawa.jp",
    "tomigusuku.okinawa.jp",
    "tonaki.okinawa.jp",
    "urasoe.okinawa.jp",
    "uruma.okinawa.jp",
    "yaese.okinawa.jp",
    "yomitan.okinawa.jp",
    "yonabaru.okinawa.jp",
    "yonaguni.okinawa.jp",
    "zamami.okinawa.jp",
    "abeno.osaka.jp",
    "chihayaakasaka.osaka.jp",
    "chuo.osaka.jp",
    "daito.osaka.jp",
    "fujiidera.osaka.jp",
    "habikino.osaka.jp",
    "hannan.osaka.jp",
    "higashiosaka.osaka.jp",
    "higashisumiyoshi.osaka.jp",
    "higashiyodogawa.osaka.jp",
    "hirakata.osaka.jp",
    "ibaraki.osaka.jp",
    "ikeda.osaka.jp",
    "izumi.osaka.jp",
    "izumiotsu.osaka.jp",
    "izumisano.osaka.jp",
    "kadoma.osaka.jp",
    "kaizuka.osaka.jp",
    "kanan.osaka.jp",
    "kashiwara.osaka.jp",
    "katano.osaka.jp",
    "kawachinagano.osaka.jp",
    "kishiwada.osaka.jp",
    "kita.osaka.jp",
    "kumatori.osaka.jp",
    "matsubara.osaka.jp",
    "minato.osaka.jp",
    "minoh.osaka.jp",
    "misaki.osaka.jp",
    "moriguchi.osaka.jp",
    "neyagawa.osaka.jp",
    "nishi.osaka.jp",
    "nose.osaka.jp",
    "osakasayama.osaka.jp",
    "sakai.osaka.jp",
    "sayama.osaka.jp",
    "sennan.osaka.jp",
    "settsu.osaka.jp",
    "shijonawate.osaka.jp",
    "shimamoto.osaka.jp",
    "suita.osaka.jp",
    "tadaoka.osaka.jp",
    "taishi.osaka.jp",
    "tajiri.osaka.jp",
    "takaishi.osaka.jp",
    "takatsuki.osaka.jp",
    "tondabayashi.osaka.jp",
    "toyonaka.osaka.jp",
    "toyono.osaka.jp",
    "yao.osaka.jp",
    "ariake.saga.jp",
    "arita.saga.jp",
    "fukudomi.saga.jp",
    "genkai.saga.jp",
    "hamatama.saga.jp",
    "hizen.saga.jp",
    "imari.saga.jp",
    "kamimine.saga.jp",
    "kanzaki.saga.jp",
    "karatsu.saga.jp",
    "kashima.saga.jp",
    "kitagata.saga.jp",
    "kitahata.saga.jp",
    "kiyama.saga.jp",
    "kouhoku.saga.jp",
    "kyuragi.saga.jp",
    "nishiarita.saga.jp",
    "ogi.saga.jp",
    "omachi.saga.jp",
    "ouchi.saga.jp",
    "saga.saga.jp",
    "shiroishi.saga.jp",
    "taku.saga.jp",
    "tara.saga.jp",
    "tosu.saga.jp",
    "yoshinogari.saga.jp",
    "arakawa.saitama.jp",
    "asaka.saitama.jp",
    "chichibu.saitama.jp",
    "fujimi.saitama.jp",
    "fujimino.saitama.jp",
    "fukaya.saitama.jp",
    "hanno.saitama.jp",
    "hanyu.saitama.jp",
    "hasuda.saitama.jp",
    "hatogaya.saitama.jp",
    "hatoyama.saitama.jp",
    "hidaka.saitama.jp",
    "higashichichibu.saitama.jp",
    "higashimatsuyama.saitama.jp",
    "honjo.saitama.jp",
    "ina.saitama.jp",
    "iruma.saitama.jp",
    "iwatsuki.saitama.jp",
    "kamiizumi.saitama.jp",
    "kamikawa.saitama.jp",
    "kamisato.saitama.jp",
    "kasukabe.saitama.jp",
    "kawagoe.saitama.jp",
    "kawaguchi.saitama.jp",
    "kawajima.saitama.jp",
    "kazo.saitama.jp",
    "kitamoto.saitama.jp",
    "koshigaya.saitama.jp",
    "kounosu.saitama.jp",
    "kuki.saitama.jp",
    "kumagaya.saitama.jp",
    "matsubushi.saitama.jp",
    "minano.saitama.jp",
    "misato.saitama.jp",
    "miyashiro.saitama.jp",
    "miyoshi.saitama.jp",
    "moroyama.saitama.jp",
    "nagatoro.saitama.jp",
    "namegawa.saitama.jp",
    "niiza.saitama.jp",
    "ogano.saitama.jp",
    "ogawa.saitama.jp",
    "ogose.saitama.jp",
    "okegawa.saitama.jp",
    "omiya.saitama.jp",
    "otaki.saitama.jp",
    "ranzan.saitama.jp",
    "ryokami.saitama.jp",
    "saitama.saitama.jp",
    "sakado.saitama.jp",
    "satte.saitama.jp",
    "sayama.saitama.jp",
    "shiki.saitama.jp",
    "shiraoka.saitama.jp",
    "soka.saitama.jp",
    "sugito.saitama.jp",
    "toda.saitama.jp",
    "tokigawa.saitama.jp",
    "tokorozawa.saitama.jp",
    "tsurugashima.saitama.jp",
    "urawa.saitama.jp",
    "warabi.saitama.jp",
    "yashio.saitama.jp",
    "yokoze.saitama.jp",
    "yono.saitama.jp",
    "yorii.saitama.jp",
    "yoshida.saitama.jp",
    "yoshikawa.saitama.jp",
    "yoshimi.saitama.jp",
    "aisho.shiga.jp",
    "gamo.shiga.jp",
    "higashiomi.shiga.jp",
    "hikone.shiga.jp",
    "koka.shiga.jp",
    "konan.shiga.jp",
    "kosei.shiga.jp",
    "koto.shiga.jp",
    "kusatsu.shiga.jp",
    "maibara.shiga.jp",
    "moriyama.shiga.jp",
    "nagahama.shiga.jp",
    "nishiazai.shiga.jp",
    "notogawa.shiga.jp",
    "omihachiman.shiga.jp",
    "otsu.shiga.jp",
    "ritto.shiga.jp",
    "ryuoh.shiga.jp",
    "takashima.shiga.jp",
    "takatsuki.shiga.jp",
    "torahime.shiga.jp",
    "toyosato.shiga.jp",
    "yasu.shiga.jp",
    "akagi.shimane.jp",
    "ama.shimane.jp",
    "gotsu.shimane.jp",
    "hamada.shimane.jp",
    "higashiizumo.shimane.jp",
    "hikawa.shimane.jp",
    "hikimi.shimane.jp",
    "izumo.shimane.jp",
    "kakinoki.shimane.jp",
    "masuda.shimane.jp",
    "matsue.shimane.jp",
    "misato.shimane.jp",
    "nishinoshima.shimane.jp",
    "ohda.shimane.jp",
    "okinoshima.shimane.jp",
    "okuizumo.shimane.jp",
    "shimane.shimane.jp",
    "tamayu.shimane.jp",
    "tsuwano.shimane.jp",
    "unnan.shimane.jp",
    "yakumo.shimane.jp",
    "yasugi.shimane.jp",
    "yatsuka.shimane.jp",
    "arai.shizuoka.jp",
    "atami.shizuoka.jp",
    "fuji.shizuoka.jp",
    "fujieda.shizuoka.jp",
    "fujikawa.shizuoka.jp",
    "fujinomiya.shizuoka.jp",
    "fukuroi.shizuoka.jp",
    "gotemba.shizuoka.jp",
    "haibara.shizuoka.jp",
    "hamamatsu.shizuoka.jp",
    "higashiizu.shizuoka.jp",
    "ito.shizuoka.jp",
    "iwata.shizuoka.jp",
    "izu.shizuoka.jp",
    "izunokuni.shizuoka.jp",
    "kakegawa.shizuoka.jp",
    "kannami.shizuoka.jp",
    "kawanehon.shizuoka.jp",
    "kawazu.shizuoka.jp",
    "kikugawa.shizuoka.jp",
    "kosai.shizuoka.jp",
    "makinohara.shizuoka.jp",
    "matsuzaki.shizuoka.jp",
    "minamiizu.shizuoka.jp",
    "mishima.shizuoka.jp",
    "morimachi.shizuoka.jp",
    "nishiizu.shizuoka.jp",
    "numazu.shizuoka.jp",
    "omaezaki.shizuoka.jp",
    "shimada.shizuoka.jp",
    "shimizu.shizuoka.jp",
    "shimoda.shizuoka.jp",
    "shizuoka.shizuoka.jp",
    "susono.shizuoka.jp",
    "yaizu.shizuoka.jp",
    "yoshida.shizuoka.jp",
    "ashikaga.tochigi.jp",
    "bato.tochigi.jp",
    "haga.tochigi.jp",
    "ichikai.tochigi.jp",
    "iwafune.tochigi.jp",
    "kaminokawa.tochigi.jp",
    "kanuma.tochigi.jp",
    "karasuyama.tochigi.jp",
    "kuroiso.tochigi.jp",
    "mashiko.tochigi.jp",
    "mibu.tochigi.jp",
    "moka.tochigi.jp",
    "motegi.tochigi.jp",
    "nasu.tochigi.jp",
    "nasushiobara.tochigi.jp",
    "nikko.tochigi.jp",
    "nishikata.tochigi.jp",
    "nogi.tochigi.jp",
    "ohira.tochigi.jp",
    "ohtawara.tochigi.jp",
    "oyama.tochigi.jp",
    "sakura.tochigi.jp",
    "sano.tochigi.jp",
    "shimotsuke.tochigi.jp",
    "shioya.tochigi.jp",
    "takanezawa.tochigi.jp",
    "tochigi.tochigi.jp",
    "tsuga.tochigi.jp",
    "ujiie.tochigi.jp",
    "utsunomiya.tochigi.jp",
    "yaita.tochigi.jp",
    "aizumi.tokushima.jp",
    "anan.tokushima.jp",
    "ichiba.tokushima.jp",
    "itano.tokushima.jp",
    "kainan.tokushima.jp",
    "komatsushima.tokushima.jp",
    "matsushige.tokushima.jp",
    "mima.tokushima.jp",
    "minami.tokushima.jp",
    "miyoshi.tokushima.jp",
    "mugi.tokushima.jp",
    "nakagawa.tokushima.jp",
    "naruto.tokushima.jp",
    "sanagochi.tokushima.jp",
    "shishikui.tokushima.jp",
    "tokushima.tokushima.jp",
    "wajiki.tokushima.jp",
    "adachi.tokyo.jp",
    "akiruno.tokyo.jp",
    "akishima.tokyo.jp",
    "aogashima.tokyo.jp",
    "arakawa.tokyo.jp",
    "bunkyo.tokyo.jp",
    "chiyoda.tokyo.jp",
    "chofu.tokyo.jp",
    "chuo.tokyo.jp",
    "edogawa.tokyo.jp",
    "fuchu.tokyo.jp",
    "fussa.tokyo.jp",
    "hachijo.tokyo.jp",
    "hachioji.tokyo.jp",
    "hamura.tokyo.jp",
    "higashikurume.tokyo.jp",
    "higashimurayama.tokyo.jp",
    "higashiyamato.tokyo.jp",
    "hino.tokyo.jp",
    "hinode.tokyo.jp",
    "hinohara.tokyo.jp",
    "inagi.tokyo.jp",
    "itabashi.tokyo.jp",
    "katsushika.tokyo.jp",
    "kita.tokyo.jp",
    "kiyose.tokyo.jp",
    "kodaira.tokyo.jp",
    "koganei.tokyo.jp",
    "kokubunji.tokyo.jp",
    "komae.tokyo.jp",
    "koto.tokyo.jp",
    "kouzushima.tokyo.jp",
    "kunitachi.tokyo.jp",
    "machida.tokyo.jp",
    "meguro.tokyo.jp",
    "minato.tokyo.jp",
    "mitaka.tokyo.jp",
    "mizuho.tokyo.jp",
    "musashimurayama.tokyo.jp",
    "musashino.tokyo.jp",
    "nakano.tokyo.jp",
    "nerima.tokyo.jp",
    "ogasawara.tokyo.jp",
    "okutama.tokyo.jp",
    "ome.tokyo.jp",
    "oshima.tokyo.jp",
    "ota.tokyo.jp",
    "setagaya.tokyo.jp",
    "shibuya.tokyo.jp",
    "shinagawa.tokyo.jp",
    "shinjuku.tokyo.jp",
    "suginami.tokyo.jp",
    "sumida.tokyo.jp",
    "tachikawa.tokyo.jp",
    "taito.tokyo.jp",
    "tama.tokyo.jp",
    "toshima.tokyo.jp",
    "chizu.tottori.jp",
    "hino.tottori.jp",
    "kawahara.tottori.jp",
    "koge.tottori.jp",
    "kotoura.tottori.jp",
    "misasa.tottori.jp",
    "nanbu.tottori.jp",
    "nichinan.tottori.jp",
    "sakaiminato.tottori.jp",
    "tottori.tottori.jp",
    "wakasa.tottori.jp",
    "yazu.tottori.jp",
    "yonago.tottori.jp",
    "asahi.toyama.jp",
    "fuchu.toyama.jp",
    "fukumitsu.toyama.jp",
    "funahashi.toyama.jp",
    "himi.toyama.jp",
    "imizu.toyama.jp",
    "inami.toyama.jp",
    "johana.toyama.jp",
    "kamiichi.toyama.jp",
    "kurobe.toyama.jp",
    "nakaniikawa.toyama.jp",
    "namerikawa.toyama.jp",
    "nanto.toyama.jp",
    "nyuzen.toyama.jp",
    "oyabe.toyama.jp",
    "taira.toyama.jp",
    "takaoka.toyama.jp",
    "tateyama.toyama.jp",
    "toga.toyama.jp",
    "tonami.toyama.jp",
    "toyama.toyama.jp",
    "unazuki.toyama.jp",
    "uozu.toyama.jp",
    "yamada.toyama.jp",
    "arida.wakayama.jp",
    "aridagawa.wakayama.jp",
    "gobo.wakayama.jp",
    "hashimoto.wakayama.jp",
    "hidaka.wakayama.jp",
    "hirogawa.wakayama.jp",
    "inami.wakayama.jp",
    "iwade.wakayama.jp",
    "kainan.wakayama.jp",
    "kamitonda.wakayama.jp",
    "katsuragi.wakayama.jp",
    "kimino.wakayama.jp",
    "kinokawa.wakayama.jp",
    "kitayama.wakayama.jp",
    "koya.wakayama.jp",
    "koza.wakayama.jp",
    "kozagawa.wakayama.jp",
    "kudoyama.wakayama.jp",
    "kushimoto.wakayama.jp",
    "mihama.wakayama.jp",
    "misato.wakayama.jp",
    "nachikatsuura.wakayama.jp",
    "shingu.wakayama.jp",
    "shirahama.wakayama.jp",
    "taiji.wakayama.jp",
    "tanabe.wakayama.jp",
    "wakayama.wakayama.jp",
    "yuasa.wakayama.jp",
    "yura.wakayama.jp",
    "asahi.yamagata.jp",
    "funagata.yamagata.jp",
    "higashine.yamagata.jp",
    "iide.yamagata.jp",
    "kahoku.yamagata.jp",
    "kaminoyama.yamagata.jp",
    "kaneyama.yamagata.jp",
    "kawanishi.yamagata.jp",
    "mamurogawa.yamagata.jp",
    "mikawa.yamagata.jp",
    "murayama.yamagata.jp",
    "nagai.yamagata.jp",
    "nakayama.yamagata.jp",
    "nanyo.yamagata.jp",
    "nishikawa.yamagata.jp",
    "obanazawa.yamagata.jp",
    "oe.yamagata.jp",
    "oguni.yamagata.jp",
    "ohkura.yamagata.jp",
    "oishida.yamagata.jp",
    "sagae.yamagata.jp",
    "sakata.yamagata.jp",
    "sakegawa.yamagata.jp",
    "shinjo.yamagata.jp",
    "shirataka.yamagata.jp",
    "shonai.yamagata.jp",
    "takahata.yamagata.jp",
    "tendo.yamagata.jp",
    "tozawa.yamagata.jp",
    "tsuruoka.yamagata.jp",
    "yamagata.yamagata.jp",
    "yamanobe.yamagata.jp",
    "yonezawa.yamagata.jp",
    "yuza.yamagata.jp",
    "abu.yamaguchi.jp",
    "hagi.yamaguchi.jp",
    "hikari.yamaguchi.jp",
    "hofu.yamaguchi.jp",
    "iwakuni.yamaguchi.jp",
    "kudamatsu.yamaguchi.jp",
    "mitou.yamaguchi.jp",
    "nagato.yamaguchi.jp",
    "oshima.yamaguchi.jp",
    "shimonoseki.yamaguchi.jp",
    "shunan.yamaguchi.jp",
    "tabuse.yamaguchi.jp",
    "tokuyama.yamaguchi.jp",
    "toyota.yamaguchi.jp",
    "ube.yamaguchi.jp",
    "yuu.yamaguchi.jp",
    "chuo.yamanashi.jp",
    "doshi.yamanashi.jp",
    "fuefuki.yamanashi.jp",
    "fujikawa.yamanashi.jp",
    "fujikawaguchiko.yamanashi.jp",
    "fujiyoshida.yamanashi.jp",
    "hayakawa.yamanashi.jp",
    "hokuto.yamanashi.jp",
    "ichikawamisato.yamanashi.jp",
    "kai.yamanashi.jp",
    "kofu.yamanashi.jp",
    "koshu.yamanashi.jp",
    "kosuge.yamanashi.jp",
    "minami-alps.yamanashi.jp",
    "minobu.yamanashi.jp",
    "nakamichi.yamanashi.jp",
    "nanbu.yamanashi.jp",
    "narusawa.yamanashi.jp",
    "nirasaki.yamanashi.jp",
    "nishikatsura.yamanashi.jp",
    "oshino.yamanashi.jp",
    "otsuki.yamanashi.jp",
    "showa.yamanashi.jp",
    "tabayama.yamanashi.jp",
    "tsuru.yamanashi.jp",
    "uenohara.yamanashi.jp",
    "yamanakako.yamanashi.jp",
    "yamanashi.yamanashi.jp",
    "ke",
    "ac.ke",
    "co.ke",
    "go.ke",
    "info.ke",
    "me.ke",
    "mobi.ke",
    "ne.ke",
    "or.ke",
    "sc.ke",
    "kg",
    "org.kg",
    "net.kg",
    "com.kg",
    "edu.kg",
    "gov.kg",
    "mil.kg",
    "*.kh",
    "ki",
    "edu.ki",
    "biz.ki",
    "net.ki",
    "org.ki",
    "gov.ki",
    "info.ki",
    "com.ki",
    "km",
    "org.km",
    "nom.km",
    "gov.km",
    "prd.km",
    "tm.km",
    "edu.km",
    "mil.km",
    "ass.km",
    "com.km",
    "coop.km",
    "asso.km",
    "presse.km",
    "medecin.km",
    "notaires.km",
    "pharmaciens.km",
    "veterinaire.km",
    "gouv.km",
    "kn",
    "net.kn",
    "org.kn",
    "edu.kn",
    "gov.kn",
    "kp",
    "com.kp",
    "edu.kp",
    "gov.kp",
    "org.kp",
    "rep.kp",
    "tra.kp",
    "kr",
    "ac.kr",
    "co.kr",
    "es.kr",
    "go.kr",
    "hs.kr",
    "kg.kr",
    "mil.kr",
    "ms.kr",
    "ne.kr",
    "or.kr",
    "pe.kr",
    "re.kr",
    "sc.kr",
    "busan.kr",
    "chungbuk.kr",
    "chungnam.kr",
    "daegu.kr",
    "daejeon.kr",
    "gangwon.kr",
    "gwangju.kr",
    "gyeongbuk.kr",
    "gyeonggi.kr",
    "gyeongnam.kr",
    "incheon.kr",
    "jeju.kr",
    "jeonbuk.kr",
    "jeonnam.kr",
    "seoul.kr",
    "ulsan.kr",
    "kw",
    "com.kw",
    "edu.kw",
    "emb.kw",
    "gov.kw",
    "ind.kw",
    "net.kw",
    "org.kw",
    "ky",
    "edu.ky",
    "gov.ky",
    "com.ky",
    "org.ky",
    "net.ky",
    "kz",
    "org.kz",
    "edu.kz",
    "net.kz",
    "gov.kz",
    "mil.kz",
    "com.kz",
    "la",
    "int.la",
    "net.la",
    "info.la",
    "edu.la",
    "gov.la",
    "per.la",
    "com.la",
    "org.la",
    "lb",
    "com.lb",
    "edu.lb",
    "gov.lb",
    "net.lb",
    "org.lb",
    "lc",
    "com.lc",
    "net.lc",
    "co.lc",
    "org.lc",
    "edu.lc",
    "gov.lc",
    "li",
    "lk",
    "gov.lk",
    "sch.lk",
    "net.lk",
    "int.lk",
    "com.lk",
    "org.lk",
    "edu.lk",
    "ngo.lk",
    "soc.lk",
    "web.lk",
    "ltd.lk",
    "assn.lk",
    "grp.lk",
    "hotel.lk",
    "ac.lk",
    "lr",
    "com.lr",
    "edu.lr",
    "gov.lr",
    "org.lr",
    "net.lr",
    "ls",
    "ac.ls",
    "biz.ls",
    "co.ls",
    "edu.ls",
    "gov.ls",
    "info.ls",
    "net.ls",
    "org.ls",
    "sc.ls",
    "lt",
    "gov.lt",
    "lu",
    "lv",
    "com.lv",
    "edu.lv",
    "gov.lv",
    "org.lv",
    "mil.lv",
    "id.lv",
    "net.lv",
    "asn.lv",
    "conf.lv",
    "ly",
    "com.ly",
    "net.ly",
    "gov.ly",
    "plc.ly",
    "edu.ly",
    "sch.ly",
    "med.ly",
    "org.ly",
    "id.ly",
    "ma",
    "co.ma",
    "net.ma",
    "gov.ma",
    "org.ma",
    "ac.ma",
    "press.ma",
    "mc",
    "tm.mc",
    "asso.mc",
    "md",
    "me",
    "co.me",
    "net.me",
    "org.me",
    "edu.me",
    "ac.me",
    "gov.me",
    "its.me",
    "priv.me",
    "mg",
    "org.mg",
    "nom.mg",
    "gov.mg",
    "prd.mg",
    "tm.mg",
    "edu.mg",
    "mil.mg",
    "com.mg",
    "co.mg",
    "mh",
    "mil",
    "mk",
    "com.mk",
    "org.mk",
    "net.mk",
    "edu.mk",
    "gov.mk",
    "inf.mk",
    "name.mk",
    "ml",
    "com.ml",
    "edu.ml",
    "gouv.ml",
    "gov.ml",
    "net.ml",
    "org.ml",
    "presse.ml",
    "*.mm",
    "mn",
    "gov.mn",
    "edu.mn",
    "org.mn",
    "mo",
    "com.mo",
    "net.mo",
    "org.mo",
    "edu.mo",
    "gov.mo",
    "mobi",
    "mp",
    "mq",
    "mr",
    "gov.mr",
    "ms",
    "com.ms",
    "edu.ms",
    "gov.ms",
    "net.ms",
    "org.ms",
    "mt",
    "com.mt",
    "edu.mt",
    "net.mt",
    "org.mt",
    "mu",
    "com.mu",
    "net.mu",
    "org.mu",
    "gov.mu",
    "ac.mu",
    "co.mu",
    "or.mu",
    "museum",
    "academy.museum",
    "agriculture.museum",
    "air.museum",
    "airguard.museum",
    "alabama.museum",
    "alaska.museum",
    "amber.museum",
    "ambulance.museum",
    "american.museum",
    "americana.museum",
    "americanantiques.museum",
    "americanart.museum",
    "amsterdam.museum",
    "and.museum",
    "annefrank.museum",
    "anthro.museum",
    "anthropology.museum",
    "antiques.museum",
    "aquarium.museum",
    "arboretum.museum",
    "archaeological.museum",
    "archaeology.museum",
    "architecture.museum",
    "art.museum",
    "artanddesign.museum",
    "artcenter.museum",
    "artdeco.museum",
    "arteducation.museum",
    "artgallery.museum",
    "arts.museum",
    "artsandcrafts.museum",
    "asmatart.museum",
    "assassination.museum",
    "assisi.museum",
    "association.museum",
    "astronomy.museum",
    "atlanta.museum",
    "austin.museum",
    "australia.museum",
    "automotive.museum",
    "aviation.museum",
    "axis.museum",
    "badajoz.museum",
    "baghdad.museum",
    "bahn.museum",
    "bale.museum",
    "baltimore.museum",
    "barcelona.museum",
    "baseball.museum",
    "basel.museum",
    "baths.museum",
    "bauern.museum",
    "beauxarts.museum",
    "beeldengeluid.museum",
    "bellevue.museum",
    "bergbau.museum",
    "berkeley.museum",
    "berlin.museum",
    "bern.museum",
    "bible.museum",
    "bilbao.museum",
    "bill.museum",
    "birdart.museum",
    "birthplace.museum",
    "bonn.museum",
    "boston.museum",
    "botanical.museum",
    "botanicalgarden.museum",
    "botanicgarden.museum",
    "botany.museum",
    "brandywinevalley.museum",
    "brasil.museum",
    "bristol.museum",
    "british.museum",
    "britishcolumbia.museum",
    "broadcast.museum",
    "brunel.museum",
    "brussel.museum",
    "brussels.museum",
    "bruxelles.museum",
    "building.museum",
    "burghof.museum",
    "bus.museum",
    "bushey.museum",
    "cadaques.museum",
    "california.museum",
    "cambridge.museum",
    "can.museum",
    "canada.museum",
    "capebreton.museum",
    "carrier.museum",
    "cartoonart.museum",
    "casadelamoneda.museum",
    "castle.museum",
    "castres.museum",
    "celtic.museum",
    "center.museum",
    "chattanooga.museum",
    "cheltenham.museum",
    "chesapeakebay.museum",
    "chicago.museum",
    "children.museum",
    "childrens.museum",
    "childrensgarden.museum",
    "chiropractic.museum",
    "chocolate.museum",
    "christiansburg.museum",
    "cincinnati.museum",
    "cinema.museum",
    "circus.museum",
    "civilisation.museum",
    "civilization.museum",
    "civilwar.museum",
    "clinton.museum",
    "clock.museum",
    "coal.museum",
    "coastaldefence.museum",
    "cody.museum",
    "coldwar.museum",
    "collection.museum",
    "colonialwilliamsburg.museum",
    "coloradoplateau.museum",
    "columbia.museum",
    "columbus.museum",
    "communication.museum",
    "communications.museum",
    "community.museum",
    "computer.museum",
    "computerhistory.museum",
    "comunicações.museum",
    "contemporary.museum",
    "contemporaryart.museum",
    "convent.museum",
    "copenhagen.museum",
    "corporation.museum",
    "correios-e-telecomunicações.museum",
    "corvette.museum",
    "costume.museum",
    "countryestate.museum",
    "county.museum",
    "crafts.museum",
    "cranbrook.museum",
    "creation.museum",
    "cultural.museum",
    "culturalcenter.museum",
    "culture.museum",
    "cyber.museum",
    "cymru.museum",
    "dali.museum",
    "dallas.museum",
    "database.museum",
    "ddr.museum",
    "decorativearts.museum",
    "delaware.museum",
    "delmenhorst.museum",
    "denmark.museum",
    "depot.museum",
    "design.museum",
    "detroit.museum",
    "dinosaur.museum",
    "discovery.museum",
    "dolls.museum",
    "donostia.museum",
    "durham.museum",
    "eastafrica.museum",
    "eastcoast.museum",
    "education.museum",
    "educational.museum",
    "egyptian.museum",
    "eisenbahn.museum",
    "elburg.museum",
    "elvendrell.museum",
    "embroidery.museum",
    "encyclopedic.museum",
    "england.museum",
    "entomology.museum",
    "environment.museum",
    "environmentalconservation.museum",
    "epilepsy.museum",
    "essex.museum",
    "estate.museum",
    "ethnology.museum",
    "exeter.museum",
    "exhibition.museum",
    "family.museum",
    "farm.museum",
    "farmequipment.museum",
    "farmers.museum",
    "farmstead.museum",
    "field.museum",
    "figueres.museum",
    "filatelia.museum",
    "film.museum",
    "fineart.museum",
    "finearts.museum",
    "finland.museum",
    "flanders.museum",
    "florida.museum",
    "force.museum",
    "fortmissoula.museum",
    "fortworth.museum",
    "foundation.museum",
    "francaise.museum",
    "frankfurt.museum",
    "franziskaner.museum",
    "freemasonry.museum",
    "freiburg.museum",
    "fribourg.museum",
    "frog.museum",
    "fundacio.museum",
    "furniture.museum",
    "gallery.museum",
    "garden.museum",
    "gateway.museum",
    "geelvinck.museum",
    "gemological.museum",
    "geology.museum",
    "georgia.museum",
    "giessen.museum",
    "glas.museum",
    "glass.museum",
    "gorge.museum",
    "grandrapids.museum",
    "graz.museum",
    "guernsey.museum",
    "halloffame.museum",
    "hamburg.museum",
    "handson.museum",
    "harvestcelebration.museum",
    "hawaii.museum",
    "health.museum",
    "heimatunduhren.museum",
    "hellas.museum",
    "helsinki.museum",
    "hembygdsforbund.museum",
    "heritage.museum",
    "histoire.museum",
    "historical.museum",
    "historicalsociety.museum",
    "historichouses.museum",
    "historisch.museum",
    "historisches.museum",
    "history.museum",
    "historyofscience.museum",
    "horology.museum",
    "house.museum",
    "humanities.museum",
    "illustration.museum",
    "imageandsound.museum",
    "indian.museum",
    "indiana.museum",
    "indianapolis.museum",
    "indianmarket.museum",
    "intelligence.museum",
    "interactive.museum",
    "iraq.museum",
    "iron.museum",
    "isleofman.museum",
    "jamison.museum",
    "jefferson.museum",
    "jerusalem.museum",
    "jewelry.museum",
    "jewish.museum",
    "jewishart.museum",
    "jfk.museum",
    "journalism.museum",
    "judaica.museum",
    "judygarland.museum",
    "juedisches.museum",
    "juif.museum",
    "karate.museum",
    "karikatur.museum",
    "kids.museum",
    "koebenhavn.museum",
    "koeln.museum",
    "kunst.museum",
    "kunstsammlung.museum",
    "kunstunddesign.museum",
    "labor.museum",
    "labour.museum",
    "lajolla.museum",
    "lancashire.museum",
    "landes.museum",
    "lans.museum",
    "läns.museum",
    "larsson.museum",
    "lewismiller.museum",
    "lincoln.museum",
    "linz.museum",
    "living.museum",
    "livinghistory.museum",
    "localhistory.museum",
    "london.museum",
    "losangeles.museum",
    "louvre.museum",
    "loyalist.museum",
    "lucerne.museum",
    "luxembourg.museum",
    "luzern.museum",
    "mad.museum",
    "madrid.museum",
    "mallorca.museum",
    "manchester.museum",
    "mansion.museum",
    "mansions.museum",
    "manx.museum",
    "marburg.museum",
    "maritime.museum",
    "maritimo.museum",
    "maryland.museum",
    "marylhurst.museum",
    "media.museum",
    "medical.museum",
    "medizinhistorisches.museum",
    "meeres.museum",
    "memorial.museum",
    "mesaverde.museum",
    "michigan.museum",
    "midatlantic.museum",
    "military.museum",
    "mill.museum",
    "miners.museum",
    "mining.museum",
    "minnesota.museum",
    "missile.museum",
    "missoula.museum",
    "modern.museum",
    "moma.museum",
    "money.museum",
    "monmouth.museum",
    "monticello.museum",
    "montreal.museum",
    "moscow.museum",
    "motorcycle.museum",
    "muenchen.museum",
    "muenster.museum",
    "mulhouse.museum",
    "muncie.museum",
    "museet.museum",
    "museumcenter.museum",
    "museumvereniging.museum",
    "music.museum",
    "national.museum",
    "nationalfirearms.museum",
    "nationalheritage.museum",
    "nativeamerican.museum",
    "naturalhistory.museum",
    "naturalhistorymuseum.museum",
    "naturalsciences.museum",
    "nature.museum",
    "naturhistorisches.museum",
    "natuurwetenschappen.museum",
    "naumburg.museum",
    "naval.museum",
    "nebraska.museum",
    "neues.museum",
    "newhampshire.museum",
    "newjersey.museum",
    "newmexico.museum",
    "newport.museum",
    "newspaper.museum",
    "newyork.museum",
    "niepce.museum",
    "norfolk.museum",
    "north.museum",
    "nrw.museum",
    "nyc.museum",
    "nyny.museum",
    "oceanographic.museum",
    "oceanographique.museum",
    "omaha.museum",
    "online.museum",
    "ontario.museum",
    "openair.museum",
    "oregon.museum",
    "oregontrail.museum",
    "otago.museum",
    "oxford.museum",
    "pacific.museum",
    "paderborn.museum",
    "palace.museum",
    "paleo.museum",
    "palmsprings.museum",
    "panama.museum",
    "paris.museum",
    "pasadena.museum",
    "pharmacy.museum",
    "philadelphia.museum",
    "philadelphiaarea.museum",
    "philately.museum",
    "phoenix.museum",
    "photography.museum",
    "pilots.museum",
    "pittsburgh.museum",
    "planetarium.museum",
    "plantation.museum",
    "plants.museum",
    "plaza.museum",
    "portal.museum",
    "portland.museum",
    "portlligat.museum",
    "posts-and-telecommunications.museum",
    "preservation.museum",
    "presidio.museum",
    "press.museum",
    "project.museum",
    "public.museum",
    "pubol.museum",
    "quebec.museum",
    "railroad.museum",
    "railway.museum",
    "research.museum",
    "resistance.museum",
    "riodejaneiro.museum",
    "rochester.museum",
    "rockart.museum",
    "roma.museum",
    "russia.museum",
    "saintlouis.museum",
    "salem.museum",
    "salvadordali.museum",
    "salzburg.museum",
    "sandiego.museum",
    "sanfrancisco.museum",
    "santabarbara.museum",
    "santacruz.museum",
    "santafe.museum",
    "saskatchewan.museum",
    "satx.museum",
    "savannahga.museum",
    "schlesisches.museum",
    "schoenbrunn.museum",
    "schokoladen.museum",
    "school.museum",
    "schweiz.museum",
    "science.museum",
    "scienceandhistory.museum",
    "scienceandindustry.museum",
    "sciencecenter.museum",
    "sciencecenters.museum",
    "science-fiction.museum",
    "sciencehistory.museum",
    "sciences.museum",
    "sciencesnaturelles.museum",
    "scotland.museum",
    "seaport.museum",
    "settlement.museum",
    "settlers.museum",
    "shell.museum",
    "sherbrooke.museum",
    "sibenik.museum",
    "silk.museum",
    "ski.museum",
    "skole.museum",
    "society.museum",
    "sologne.museum",
    "soundandvision.museum",
    "southcarolina.museum",
    "southwest.museum",
    "space.museum",
    "spy.museum",
    "square.museum",
    "stadt.museum",
    "stalbans.museum",
    "starnberg.museum",
    "state.museum",
    "stateofdelaware.museum",
    "station.museum",
    "steam.museum",
    "steiermark.museum",
    "stjohn.museum",
    "stockholm.museum",
    "stpetersburg.museum",
    "stuttgart.museum",
    "suisse.museum",
    "surgeonshall.museum",
    "surrey.museum",
    "svizzera.museum",
    "sweden.museum",
    "sydney.museum",
    "tank.museum",
    "tcm.museum",
    "technology.museum",
    "telekommunikation.museum",
    "television.museum",
    "texas.museum",
    "textile.museum",
    "theater.museum",
    "time.museum",
    "timekeeping.museum",
    "topology.museum",
    "torino.museum",
    "touch.museum",
    "town.museum",
    "transport.museum",
    "tree.museum",
    "trolley.museum",
    "trust.museum",
    "trustee.museum",
    "uhren.museum",
    "ulm.museum",
    "undersea.museum",
    "university.museum",
    "usa.museum",
    "usantiques.museum",
    "usarts.museum",
    "uscountryestate.museum",
    "usculture.museum",
    "usdecorativearts.museum",
    "usgarden.museum",
    "ushistory.museum",
    "ushuaia.museum",
    "uslivinghistory.museum",
    "utah.museum",
    "uvic.museum",
    "valley.museum",
    "vantaa.museum",
    "versailles.museum",
    "viking.museum",
    "village.museum",
    "virginia.museum",
    "virtual.museum",
    "virtuel.museum",
    "vlaanderen.museum",
    "volkenkunde.museum",
    "wales.museum",
    "wallonie.museum",
    "war.museum",
    "washingtondc.museum",
    "watchandclock.museum",
    "watch-and-clock.museum",
    "western.museum",
    "westfalen.museum",
    "whaling.museum",
    "wildlife.museum",
    "williamsburg.museum",
    "windmill.museum",
    "workshop.museum",
    "york.museum",
    "yorkshire.museum",
    "yosemite.museum",
    "youth.museum",
    "zoological.museum",
    "zoology.museum",
    "ירושלים.museum",
    "иком.museum",
    "mv",
    "aero.mv",
    "biz.mv",
    "com.mv",
    "coop.mv",
    "edu.mv",
    "gov.mv",
    "info.mv",
    "int.mv",
    "mil.mv",
    "museum.mv",
    "name.mv",
    "net.mv",
    "org.mv",
    "pro.mv",
    "mw",
    "ac.mw",
    "biz.mw",
    "co.mw",
    "com.mw",
    "coop.mw",
    "edu.mw",
    "gov.mw",
    "int.mw",
    "museum.mw",
    "net.mw",
    "org.mw",
    "mx",
    "com.mx",
    "org.mx",
    "gob.mx",
    "edu.mx",
    "net.mx",
    "my",
    "com.my",
    "net.my",
    "org.my",
    "gov.my",
    "edu.my",
    "mil.my",
    "name.my",
    "mz",
    "ac.mz",
    "adv.mz",
    "co.mz",
    "edu.mz",
    "gov.mz",
    "mil.mz",
    "net.mz",
    "org.mz",
    "na",
    "info.na",
    "pro.na",
    "name.na",
    "school.na",
    "or.na",
    "dr.na",
    "us.na",
    "mx.na",
    "ca.na",
    "in.na",
    "cc.na",
    "tv.na",
    "ws.na",
    "mobi.na",
    "co.na",
    "com.na",
    "org.na",
    "name",
    "nc",
    "asso.nc",
    "nom.nc",
    "ne",
    "net",
    "nf",
    "com.nf",
    "net.nf",
    "per.nf",
    "rec.nf",
    "web.nf",
    "arts.nf",
    "firm.nf",
    "info.nf",
    "other.nf",
    "store.nf",
    "ng",
    "com.ng",
    "edu.ng",
    "gov.ng",
    "i.ng",
    "mil.ng",
    "mobi.ng",
    "name.ng",
    "net.ng",
    "org.ng",
    "sch.ng",
    "ni",
    "ac.ni",
    "biz.ni",
    "co.ni",
    "com.ni",
    "edu.ni",
    "gob.ni",
    "in.ni",
    "info.ni",
    "int.ni",
    "mil.ni",
    "net.ni",
    "nom.ni",
    "org.ni",
    "web.ni",
    "nl",
    "no",
    "fhs.no",
    "vgs.no",
    "fylkesbibl.no",
    "folkebibl.no",
    "museum.no",
    "idrett.no",
    "priv.no",
    "mil.no",
    "stat.no",
    "dep.no",
    "kommune.no",
    "herad.no",
    "aa.no",
    "ah.no",
    "bu.no",
    "fm.no",
    "hl.no",
    "hm.no",
    "jan-mayen.no",
    "mr.no",
    "nl.no",
    "nt.no",
    "of.no",
    "ol.no",
    "oslo.no",
    "rl.no",
    "sf.no",
    "st.no",
    "svalbard.no",
    "tm.no",
    "tr.no",
    "va.no",
    "vf.no",
    "gs.aa.no",
    "gs.ah.no",
    "gs.bu.no",
    "gs.fm.no",
    "gs.hl.no",
    "gs.hm.no",
    "gs.jan-mayen.no",
    "gs.mr.no",
    "gs.nl.no",
    "gs.nt.no",
    "gs.of.no",
    "gs.ol.no",
    "gs.oslo.no",
    "gs.rl.no",
    "gs.sf.no",
    "gs.st.no",
    "gs.svalbard.no",
    "gs.tm.no",
    "gs.tr.no",
    "gs.va.no",
    "gs.vf.no",
    "akrehamn.no",
    "åkrehamn.no",
    "algard.no",
    "ålgård.no",
    "arna.no",
    "brumunddal.no",
    "bryne.no",
    "bronnoysund.no",
    "brønnøysund.no",
    "drobak.no",
    "drøbak.no",
    "egersund.no",
    "fetsund.no",
    "floro.no",
    "florø.no",
    "fredrikstad.no",
    "hokksund.no",
    "honefoss.no",
    "hønefoss.no",
    "jessheim.no",
    "jorpeland.no",
    "jørpeland.no",
    "kirkenes.no",
    "kopervik.no",
    "krokstadelva.no",
    "langevag.no",
    "langevåg.no",
    "leirvik.no",
    "mjondalen.no",
    "mjøndalen.no",
    "mo-i-rana.no",
    "mosjoen.no",
    "mosjøen.no",
    "nesoddtangen.no",
    "orkanger.no",
    "osoyro.no",
    "osøyro.no",
    "raholt.no",
    "råholt.no",
    "sandnessjoen.no",
    "sandnessjøen.no",
    "skedsmokorset.no",
    "slattum.no",
    "spjelkavik.no",
    "stathelle.no",
    "stavern.no",
    "stjordalshalsen.no",
    "stjørdalshalsen.no",
    "tananger.no",
    "tranby.no",
    "vossevangen.no",
    "afjord.no",
    "åfjord.no",
    "agdenes.no",
    "al.no",
    "ål.no",
    "alesund.no",
    "ålesund.no",
    "alstahaug.no",
    "alta.no",
    "áltá.no",
    "alaheadju.no",
    "álaheadju.no",
    "alvdal.no",
    "amli.no",
    "åmli.no",
    "amot.no",
    "åmot.no",
    "andebu.no",
    "andoy.no",
    "andøy.no",
    "andasuolo.no",
    "ardal.no",
    "årdal.no",
    "aremark.no",
    "arendal.no",
    "ås.no",
    "aseral.no",
    "åseral.no",
    "asker.no",
    "askim.no",
    "askvoll.no",
    "askoy.no",
    "askøy.no",
    "asnes.no",
    "åsnes.no",
    "audnedaln.no",
    "aukra.no",
    "aure.no",
    "aurland.no",
    "aurskog-holand.no",
    "aurskog-høland.no",
    "austevoll.no",
    "austrheim.no",
    "averoy.no",
    "averøy.no",
    "balestrand.no",
    "ballangen.no",
    "balat.no",
    "bálát.no",
    "balsfjord.no",
    "bahccavuotna.no",
    "báhccavuotna.no",
    "bamble.no",
    "bardu.no",
    "beardu.no",
    "beiarn.no",
    "bajddar.no",
    "bájddar.no",
    "baidar.no",
    "báidár.no",
    "berg.no",
    "bergen.no",
    "berlevag.no",
    "berlevåg.no",
    "bearalvahki.no",
    "bearalváhki.no",
    "bindal.no",
    "birkenes.no",
    "bjarkoy.no",
    "bjarkøy.no",
    "bjerkreim.no",
    "bjugn.no",
    "bodo.no",
    "bodø.no",
    "badaddja.no",
    "bådåddjå.no",
    "budejju.no",
    "bokn.no",
    "bremanger.no",
    "bronnoy.no",
    "brønnøy.no",
    "bygland.no",
    "bykle.no",
    "barum.no",
    "bærum.no",
    "bo.telemark.no",
    "bø.telemark.no",
    "bo.nordland.no",
    "bø.nordland.no",
    "bievat.no",
    "bievát.no",
    "bomlo.no",
    "bømlo.no",
    "batsfjord.no",
    "båtsfjord.no",
    "bahcavuotna.no",
    "báhcavuotna.no",
    "dovre.no",
    "drammen.no",
    "drangedal.no",
    "dyroy.no",
    "dyrøy.no",
    "donna.no",
    "dønna.no",
    "eid.no",
    "eidfjord.no",
    "eidsberg.no",
    "eidskog.no",
    "eidsvoll.no",
    "eigersund.no",
    "elverum.no",
    "enebakk.no",
    "engerdal.no",
    "etne.no",
    "etnedal.no",
    "evenes.no",
    "evenassi.no",
    "evenášši.no",
    "evje-og-hornnes.no",
    "farsund.no",
    "fauske.no",
    "fuossko.no",
    "fuoisku.no",
    "fedje.no",
    "fet.no",
    "finnoy.no",
    "finnøy.no",
    "fitjar.no",
    "fjaler.no",
    "fjell.no",
    "flakstad.no",
    "flatanger.no",
    "flekkefjord.no",
    "flesberg.no",
    "flora.no",
    "fla.no",
    "flå.no",
    "folldal.no",
    "forsand.no",
    "fosnes.no",
    "frei.no",
    "frogn.no",
    "froland.no",
    "frosta.no",
    "frana.no",
    "fræna.no",
    "froya.no",
    "frøya.no",
    "fusa.no",
    "fyresdal.no",
    "forde.no",
    "førde.no",
    "gamvik.no",
    "gangaviika.no",
    "gáŋgaviika.no",
    "gaular.no",
    "gausdal.no",
    "gildeskal.no",
    "gildeskål.no",
    "giske.no",
    "gjemnes.no",
    "gjerdrum.no",
    "gjerstad.no",
    "gjesdal.no",
    "gjovik.no",
    "gjøvik.no",
    "gloppen.no",
    "gol.no",
    "gran.no",
    "grane.no",
    "granvin.no",
    "gratangen.no",
    "grimstad.no",
    "grong.no",
    "kraanghke.no",
    "kråanghke.no",
    "grue.no",
    "gulen.no",
    "hadsel.no",
    "halden.no",
    "halsa.no",
    "hamar.no",
    "hamaroy.no",
    "habmer.no",
    "hábmer.no",
    "hapmir.no",
    "hápmir.no",
    "hammerfest.no",
    "hammarfeasta.no",
    "hámmárfeasta.no",
    "haram.no",
    "hareid.no",
    "harstad.no",
    "hasvik.no",
    "aknoluokta.no",
    "ákŋoluokta.no",
    "hattfjelldal.no",
    "aarborte.no",
    "haugesund.no",
    "hemne.no",
    "hemnes.no",
    "hemsedal.no",
    "heroy.more-og-romsdal.no",
    "herøy.møre-og-romsdal.no",
    "heroy.nordland.no",
    "herøy.nordland.no",
    "hitra.no",
    "hjartdal.no",
    "hjelmeland.no",
    "hobol.no",
    "hobøl.no",
    "hof.no",
    "hol.no",
    "hole.no",
    "holmestrand.no",
    "holtalen.no",
    "holtålen.no",
    "hornindal.no",
    "horten.no",
    "hurdal.no",
    "hurum.no",
    "hvaler.no",
    "hyllestad.no",
    "hagebostad.no",
    "hægebostad.no",
    "hoyanger.no",
    "høyanger.no",
    "hoylandet.no",
    "høylandet.no",
    "ha.no",
    "hå.no",
    "ibestad.no",
    "inderoy.no",
    "inderøy.no",
    "iveland.no",
    "jevnaker.no",
    "jondal.no",
    "jolster.no",
    "jølster.no",
    "karasjok.no",
    "karasjohka.no",
    "kárášjohka.no",
    "karlsoy.no",
    "galsa.no",
    "gálsá.no",
    "karmoy.no",
    "karmøy.no",
    "kautokeino.no",
    "guovdageaidnu.no",
    "klepp.no",
    "klabu.no",
    "klæbu.no",
    "kongsberg.no",
    "kongsvinger.no",
    "kragero.no",
    "kragerø.no",
    "kristiansand.no",
    "kristiansund.no",
    "krodsherad.no",
    "krødsherad.no",
    "kvalsund.no",
    "rahkkeravju.no",
    "ráhkkerávju.no",
    "kvam.no",
    "kvinesdal.no",
    "kvinnherad.no",
    "kviteseid.no",
    "kvitsoy.no",
    "kvitsøy.no",
    "kvafjord.no",
    "kvæfjord.no",
    "giehtavuoatna.no",
    "kvanangen.no",
    "kvænangen.no",
    "navuotna.no",
    "návuotna.no",
    "kafjord.no",
    "kåfjord.no",
    "gaivuotna.no",
    "gáivuotna.no",
    "larvik.no",
    "lavangen.no",
    "lavagis.no",
    "loabat.no",
    "loabát.no",
    "lebesby.no",
    "davvesiida.no",
    "leikanger.no",
    "leirfjord.no",
    "leka.no",
    "leksvik.no",
    "lenvik.no",
    "leangaviika.no",
    "leaŋgaviika.no",
    "lesja.no",
    "levanger.no",
    "lier.no",
    "lierne.no",
    "lillehammer.no",
    "lillesand.no",
    "lindesnes.no",
    "lindas.no",
    "lindås.no",
    "lom.no",
    "loppa.no",
    "lahppi.no",
    "láhppi.no",
    "lund.no",
    "lunner.no",
    "luroy.no",
    "lurøy.no",
    "luster.no",
    "lyngdal.no",
    "lyngen.no",
    "ivgu.no",
    "lardal.no",
    "lerdal.no",
    "lærdal.no",
    "lodingen.no",
    "lødingen.no",
    "lorenskog.no",
    "lørenskog.no",
    "loten.no",
    "løten.no",
    "malvik.no",
    "masoy.no",
    "måsøy.no",
    "muosat.no",
    "muosát.no",
    "mandal.no",
    "marker.no",
    "marnardal.no",
    "masfjorden.no",
    "meland.no",
    "meldal.no",
    "melhus.no",
    "meloy.no",
    "meløy.no",
    "meraker.no",
    "meråker.no",
    "moareke.no",
    "moåreke.no",
    "midsund.no",
    "midtre-gauldal.no",
    "modalen.no",
    "modum.no",
    "molde.no",
    "moskenes.no",
    "moss.no",
    "mosvik.no",
    "malselv.no",
    "målselv.no",
    "malatvuopmi.no",
    "málatvuopmi.no",
    "namdalseid.no",
    "aejrie.no",
    "namsos.no",
    "namsskogan.no",
    "naamesjevuemie.no",
    "nååmesjevuemie.no",
    "laakesvuemie.no",
    "nannestad.no",
    "narvik.no",
    "narviika.no",
    "naustdal.no",
    "nedre-eiker.no",
    "nes.akershus.no",
    "nes.buskerud.no",
    "nesna.no",
    "nesodden.no",
    "nesseby.no",
    "unjarga.no",
    "unjárga.no",
    "nesset.no",
    "nissedal.no",
    "nittedal.no",
    "nord-aurdal.no",
    "nord-fron.no",
    "nord-odal.no",
    "norddal.no",
    "nordkapp.no",
    "davvenjarga.no",
    "davvenjárga.no",
    "nordre-land.no",
    "nordreisa.no",
    "raisa.no",
    "ráisa.no",
    "nore-og-uvdal.no",
    "notodden.no",
    "naroy.no",
    "nærøy.no",
    "notteroy.no",
    "nøtterøy.no",
    "odda.no",
    "oksnes.no",
    "øksnes.no",
    "oppdal.no",
    "oppegard.no",
    "oppegård.no",
    "orkdal.no",
    "orland.no",
    "ørland.no",
    "orskog.no",
    "ørskog.no",
    "orsta.no",
    "ørsta.no",
    "os.hedmark.no",
    "os.hordaland.no",
    "osen.no",
    "osteroy.no",
    "osterøy.no",
    "ostre-toten.no",
    "østre-toten.no",
    "overhalla.no",
    "ovre-eiker.no",
    "øvre-eiker.no",
    "oyer.no",
    "øyer.no",
    "oygarden.no",
    "øygarden.no",
    "oystre-slidre.no",
    "øystre-slidre.no",
    "porsanger.no",
    "porsangu.no",
    "porsáŋgu.no",
    "porsgrunn.no",
    "radoy.no",
    "radøy.no",
    "rakkestad.no",
    "rana.no",
    "ruovat.no",
    "randaberg.no",
    "rauma.no",
    "rendalen.no",
    "rennebu.no",
    "rennesoy.no",
    "rennesøy.no",
    "rindal.no",
    "ringebu.no",
    "ringerike.no",
    "ringsaker.no",
    "rissa.no",
    "risor.no",
    "risør.no",
    "roan.no",
    "rollag.no",
    "rygge.no",
    "ralingen.no",
    "rælingen.no",
    "rodoy.no",
    "rødøy.no",
    "romskog.no",
    "rømskog.no",
    "roros.no",
    "røros.no",
    "rost.no",
    "røst.no",
    "royken.no",
    "røyken.no",
    "royrvik.no",
    "røyrvik.no",
    "rade.no",
    "råde.no",
    "salangen.no",
    "siellak.no",
    "saltdal.no",
    "salat.no",
    "sálát.no",
    "sálat.no",
    "samnanger.no",
    "sande.more-og-romsdal.no",
    "sande.møre-og-romsdal.no",
    "sande.vestfold.no",
    "sandefjord.no",
    "sandnes.no",
    "sandoy.no",
    "sandøy.no",
    "sarpsborg.no",
    "sauda.no",
    "sauherad.no",
    "sel.no",
    "selbu.no",
    "selje.no",
    "seljord.no",
    "sigdal.no",
    "siljan.no",
    "sirdal.no",
    "skaun.no",
    "skedsmo.no",
    "ski.no",
    "skien.no",
    "skiptvet.no",
    "skjervoy.no",
    "skjervøy.no",
    "skierva.no",
    "skiervá.no",
    "skjak.no",
    "skjåk.no",
    "skodje.no",
    "skanland.no",
    "skånland.no",
    "skanit.no",
    "skánit.no",
    "smola.no",
    "smøla.no",
    "snillfjord.no",
    "snasa.no",
    "snåsa.no",
    "snoasa.no",
    "snaase.no",
    "snåase.no",
    "sogndal.no",
    "sokndal.no",
    "sola.no",
    "solund.no",
    "songdalen.no",
    "sortland.no",
    "spydeberg.no",
    "stange.no",
    "stavanger.no",
    "steigen.no",
    "steinkjer.no",
    "stjordal.no",
    "stjørdal.no",
    "stokke.no",
    "stor-elvdal.no",
    "stord.no",
    "stordal.no",
    "storfjord.no",
    "omasvuotna.no",
    "strand.no",
    "stranda.no",
    "stryn.no",
    "sula.no",
    "suldal.no",
    "sund.no",
    "sunndal.no",
    "surnadal.no",
    "sveio.no",
    "svelvik.no",
    "sykkylven.no",
    "sogne.no",
    "søgne.no",
    "somna.no",
    "sømna.no",
    "sondre-land.no",
    "søndre-land.no",
    "sor-aurdal.no",
    "sør-aurdal.no",
    "sor-fron.no",
    "sør-fron.no",
    "sor-odal.no",
    "sør-odal.no",
    "sor-varanger.no",
    "sør-varanger.no",
    "matta-varjjat.no",
    "mátta-várjjat.no",
    "sorfold.no",
    "sørfold.no",
    "sorreisa.no",
    "sørreisa.no",
    "sorum.no",
    "sørum.no",
    "tana.no",
    "deatnu.no",
    "time.no",
    "tingvoll.no",
    "tinn.no",
    "tjeldsund.no",
    "dielddanuorri.no",
    "tjome.no",
    "tjøme.no",
    "tokke.no",
    "tolga.no",
    "torsken.no",
    "tranoy.no",
    "tranøy.no",
    "tromso.no",
    "tromsø.no",
    "tromsa.no",
    "romsa.no",
    "trondheim.no",
    "troandin.no",
    "trysil.no",
    "trana.no",
    "træna.no",
    "trogstad.no",
    "trøgstad.no",
    "tvedestrand.no",
    "tydal.no",
    "tynset.no",
    "tysfjord.no",
    "divtasvuodna.no",
    "divttasvuotna.no",
    "tysnes.no",
    "tysvar.no",
    "tysvær.no",
    "tonsberg.no",
    "tønsberg.no",
    "ullensaker.no",
    "ullensvang.no",
    "ulvik.no",
    "utsira.no",
    "vadso.no",
    "vadsø.no",
    "cahcesuolo.no",
    "čáhcesuolo.no",
    "vaksdal.no",
    "valle.no",
    "vang.no",
    "vanylven.no",
    "vardo.no",
    "vardø.no",
    "varggat.no",
    "várggát.no",
    "vefsn.no",
    "vaapste.no",
    "vega.no",
    "vegarshei.no",
    "vegårshei.no",
    "vennesla.no",
    "verdal.no",
    "verran.no",
    "vestby.no",
    "vestnes.no",
    "vestre-slidre.no",
    "vestre-toten.no",
    "vestvagoy.no",
    "vestvågøy.no",
    "vevelstad.no",
    "vik.no",
    "vikna.no",
    "vindafjord.no",
    "volda.no",
    "voss.no",
    "varoy.no",
    "værøy.no",
    "vagan.no",
    "vågan.no",
    "voagat.no",
    "vagsoy.no",
    "vågsøy.no",
    "vaga.no",
    "vågå.no",
    "valer.ostfold.no",
    "våler.østfold.no",
    "valer.hedmark.no",
    "våler.hedmark.no",
    "*.np",
    "nr",
    "biz.nr",
    "info.nr",
    "gov.nr",
    "edu.nr",
    "org.nr",
    "net.nr",
    "com.nr",
    "nu",
    "nz",
    "ac.nz",
    "co.nz",
    "cri.nz",
    "geek.nz",
    "gen.nz",
    "govt.nz",
    "health.nz",
    "iwi.nz",
    "kiwi.nz",
    "maori.nz",
    "mil.nz",
    "māori.nz",
    "net.nz",
    "org.nz",
    "parliament.nz",
    "school.nz",
    "om",
    "co.om",
    "com.om",
    "edu.om",
    "gov.om",
    "med.om",
    "museum.om",
    "net.om",
    "org.om",
    "pro.om",
    "onion",
    "org",
    "pa",
    "ac.pa",
    "gob.pa",
    "com.pa",
    "org.pa",
    "sld.pa",
    "edu.pa",
    "net.pa",
    "ing.pa",
    "abo.pa",
    "med.pa",
    "nom.pa",
    "pe",
    "edu.pe",
    "gob.pe",
    "nom.pe",
    "mil.pe",
    "org.pe",
    "com.pe",
    "net.pe",
    "pf",
    "com.pf",
    "org.pf",
    "edu.pf",
    "*.pg",
    "ph",
    "com.ph",
    "net.ph",
    "org.ph",
    "gov.ph",
    "edu.ph",
    "ngo.ph",
    "mil.ph",
    "i.ph",
    "pk",
    "com.pk",
    "net.pk",
    "edu.pk",
    "org.pk",
    "fam.pk",
    "biz.pk",
    "web.pk",
    "gov.pk",
    "gob.pk",
    "gok.pk",
    "gon.pk",
    "gop.pk",
    "gos.pk",
    "info.pk",
    "pl",
    "com.pl",
    "net.pl",
    "org.pl",
    "aid.pl",
    "agro.pl",
    "atm.pl",
    "auto.pl",
    "biz.pl",
    "edu.pl",
    "gmina.pl",
    "gsm.pl",
    "info.pl",
    "mail.pl",
    "miasta.pl",
    "media.pl",
    "mil.pl",
    "nieruchomosci.pl",
    "nom.pl",
    "pc.pl",
    "powiat.pl",
    "priv.pl",
    "realestate.pl",
    "rel.pl",
    "sex.pl",
    "shop.pl",
    "sklep.pl",
    "sos.pl",
    "szkola.pl",
    "targi.pl",
    "tm.pl",
    "tourism.pl",
    "travel.pl",
    "turystyka.pl",
    "gov.pl",
    "ap.gov.pl",
    "ic.gov.pl",
    "is.gov.pl",
    "us.gov.pl",
    "kmpsp.gov.pl",
    "kppsp.gov.pl",
    "kwpsp.gov.pl",
    "psp.gov.pl",
    "wskr.gov.pl",
    "kwp.gov.pl",
    "mw.gov.pl",
    "ug.gov.pl",
    "um.gov.pl",
    "umig.gov.pl",
    "ugim.gov.pl",
    "upow.gov.pl",
    "uw.gov.pl",
    "starostwo.gov.pl",
    "pa.gov.pl",
    "po.gov.pl",
    "psse.gov.pl",
    "pup.gov.pl",
    "rzgw.gov.pl",
    "sa.gov.pl",
    "so.gov.pl",
    "sr.gov.pl",
    "wsa.gov.pl",
    "sko.gov.pl",
    "uzs.gov.pl",
    "wiih.gov.pl",
    "winb.gov.pl",
    "pinb.gov.pl",
    "wios.gov.pl",
    "witd.gov.pl",
    "wzmiuw.gov.pl",
    "piw.gov.pl",
    "wiw.gov.pl",
    "griw.gov.pl",
    "wif.gov.pl",
    "oum.gov.pl",
    "sdn.gov.pl",
    "zp.gov.pl",
    "uppo.gov.pl",
    "mup.gov.pl",
    "wuoz.gov.pl",
    "konsulat.gov.pl",
    "oirm.gov.pl",
    "augustow.pl",
    "babia-gora.pl",
    "bedzin.pl",
    "beskidy.pl",
    "bialowieza.pl",
    "bialystok.pl",
    "bielawa.pl",
    "bieszczady.pl",
    "boleslawiec.pl",
    "bydgoszcz.pl",
    "bytom.pl",
    "cieszyn.pl",
    "czeladz.pl",
    "czest.pl",
    "dlugoleka.pl",
    "elblag.pl",
    "elk.pl",
    "glogow.pl",
    "gniezno.pl",
    "gorlice.pl",
    "grajewo.pl",
    "ilawa.pl",
    "jaworzno.pl",
    "jelenia-gora.pl",
    "jgora.pl",
    "kalisz.pl",
    "kazimierz-dolny.pl",
    "karpacz.pl",
    "kartuzy.pl",
    "kaszuby.pl",
    "katowice.pl",
    "kepno.pl",
    "ketrzyn.pl",
    "klodzko.pl",
    "kobierzyce.pl",
    "kolobrzeg.pl",
    "konin.pl",
    "konskowola.pl",
    "kutno.pl",
    "lapy.pl",
    "lebork.pl",
    "legnica.pl",
    "lezajsk.pl",
    "limanowa.pl",
    "lomza.pl",
    "lowicz.pl",
    "lubin.pl",
    "lukow.pl",
    "malbork.pl",
    "malopolska.pl",
    "mazowsze.pl",
    "mazury.pl",
    "mielec.pl",
    "mielno.pl",
    "mragowo.pl",
    "naklo.pl",
    "nowaruda.pl",
    "nysa.pl",
    "olawa.pl",
    "olecko.pl",
    "olkusz.pl",
    "olsztyn.pl",
    "opoczno.pl",
    "opole.pl",
    "ostroda.pl",
    "ostroleka.pl",
    "ostrowiec.pl",
    "ostrowwlkp.pl",
    "pila.pl",
    "pisz.pl",
    "podhale.pl",
    "podlasie.pl",
    "polkowice.pl",
    "pomorze.pl",
    "pomorskie.pl",
    "prochowice.pl",
    "pruszkow.pl",
    "przeworsk.pl",
    "pulawy.pl",
    "radom.pl",
    "rawa-maz.pl",
    "rybnik.pl",
    "rzeszow.pl",
    "sanok.pl",
    "sejny.pl",
    "slask.pl",
    "slupsk.pl",
    "sosnowiec.pl",
    "stalowa-wola.pl",
    "skoczow.pl",
    "starachowice.pl",
    "stargard.pl",
    "suwalki.pl",
    "swidnica.pl",
    "swiebodzin.pl",
    "swinoujscie.pl",
    "szczecin.pl",
    "szczytno.pl",
    "tarnobrzeg.pl",
    "tgory.pl",
    "turek.pl",
    "tychy.pl",
    "ustka.pl",
    "walbrzych.pl",
    "warmia.pl",
    "warszawa.pl",
    "waw.pl",
    "wegrow.pl",
    "wielun.pl",
    "wlocl.pl",
    "wloclawek.pl",
    "wodzislaw.pl",
    "wolomin.pl",
    "wroclaw.pl",
    "zachpomor.pl",
    "zagan.pl",
    "zarow.pl",
    "zgora.pl",
    "zgorzelec.pl",
    "pm",
    "pn",
    "gov.pn",
    "co.pn",
    "org.pn",
    "edu.pn",
    "net.pn",
    "post",
    "pr",
    "com.pr",
    "net.pr",
    "org.pr",
    "gov.pr",
    "edu.pr",
    "isla.pr",
    "pro.pr",
    "biz.pr",
    "info.pr",
    "name.pr",
    "est.pr",
    "prof.pr",
    "ac.pr",
    "pro",
    "aaa.pro",
    "aca.pro",
    "acct.pro",
    "avocat.pro",
    "bar.pro",
    "cpa.pro",
    "eng.pro",
    "jur.pro",
    "law.pro",
    "med.pro",
    "recht.pro",
    "ps",
    "edu.ps",
    "gov.ps",
    "sec.ps",
    "plo.ps",
    "com.ps",
    "org.ps",
    "net.ps",
    "pt",
    "net.pt",
    "gov.pt",
    "org.pt",
    "edu.pt",
    "int.pt",
    "publ.pt",
    "com.pt",
    "nome.pt",
    "pw",
    "co.pw",
    "ne.pw",
    "or.pw",
    "ed.pw",
    "go.pw",
    "belau.pw",
    "py",
    "com.py",
    "coop.py",
    "edu.py",
    "gov.py",
    "mil.py",
    "net.py",
    "org.py",
    "qa",
    "com.qa",
    "edu.qa",
    "gov.qa",
    "mil.qa",
    "name.qa",
    "net.qa",
    "org.qa",
    "sch.qa",
    "re",
    "asso.re",
    "com.re",
    "nom.re",
    "ro",
    "arts.ro",
    "com.ro",
    "firm.ro",
    "info.ro",
    "nom.ro",
    "nt.ro",
    "org.ro",
    "rec.ro",
    "store.ro",
    "tm.ro",
    "www.ro",
    "rs",
    "ac.rs",
    "co.rs",
    "edu.rs",
    "gov.rs",
    "in.rs",
    "org.rs",
    "ru",
    "ac.ru",
    "edu.ru",
    "gov.ru",
    "int.ru",
    "mil.ru",
    "test.ru",
    "rw",
    "ac.rw",
    "co.rw",
    "coop.rw",
    "gov.rw",
    "mil.rw",
    "net.rw",
    "org.rw",
    "sa",
    "com.sa",
    "net.sa",
    "org.sa",
    "gov.sa",
    "med.sa",
    "pub.sa",
    "edu.sa",
    "sch.sa",
    "sb",
    "com.sb",
    "edu.sb",
    "gov.sb",
    "net.sb",
    "org.sb",
    "sc",
    "com.sc",
    "gov.sc",
    "net.sc",
    "org.sc",
    "edu.sc",
    "sd",
    "com.sd",
    "net.sd",
    "org.sd",
    "edu.sd",
    "med.sd",
    "tv.sd",
    "gov.sd",
    "info.sd",
    "se",
    "a.se",
    "ac.se",
    "b.se",
    "bd.se",
    "brand.se",
    "c.se",
    "d.se",
    "e.se",
    "f.se",
    "fh.se",
    "fhsk.se",
    "fhv.se",
    "g.se",
    "h.se",
    "i.se",
    "k.se",
    "komforb.se",
    "kommunalforbund.se",
    "komvux.se",
    "l.se",
    "lanbib.se",
    "m.se",
    "n.se",
    "naturbruksgymn.se",
    "o.se",
    "org.se",
    "p.se",
    "parti.se",
    "pp.se",
    "press.se",
    "r.se",
    "s.se",
    "t.se",
    "tm.se",
    "u.se",
    "w.se",
    "x.se",
    "y.se",
    "z.se",
    "sg",
    "com.sg",
    "net.sg",
    "org.sg",
    "gov.sg",
    "edu.sg",
    "per.sg",
    "sh",
    "com.sh",
    "net.sh",
    "gov.sh",
    "org.sh",
    "mil.sh",
    "si",
    "sj",
    "sk",
    "sl",
    "com.sl",
    "net.sl",
    "edu.sl",
    "gov.sl",
    "org.sl",
    "sm",
    "sn",
    "art.sn",
    "com.sn",
    "edu.sn",
    "gouv.sn",
    "org.sn",
    "perso.sn",
    "univ.sn",
    "so",
    "com.so",
    "net.so",
    "org.so",
    "sr",
    "ss",
    "biz.ss",
    "com.ss",
    "edu.ss",
    "gov.ss",
    "net.ss",
    "org.ss",
    "st",
    "co.st",
    "com.st",
    "consulado.st",
    "edu.st",
    "embaixada.st",
    "gov.st",
    "mil.st",
    "net.st",
    "org.st",
    "principe.st",
    "saotome.st",
    "store.st",
    "su",
    "sv",
    "com.sv",
    "edu.sv",
    "gob.sv",
    "org.sv",
    "red.sv",
    "sx",
    "gov.sx",
    "sy",
    "edu.sy",
    "gov.sy",
    "net.sy",
    "mil.sy",
    "com.sy",
    "org.sy",
    "sz",
    "co.sz",
    "ac.sz",
    "org.sz",
    "tc",
    "td",
    "tel",
    "tf",
    "tg",
    "th",
    "ac.th",
    "co.th",
    "go.th",
    "in.th",
    "mi.th",
    "net.th",
    "or.th",
    "tj",
    "ac.tj",
    "biz.tj",
    "co.tj",
    "com.tj",
    "edu.tj",
    "go.tj",
    "gov.tj",
    "int.tj",
    "mil.tj",
    "name.tj",
    "net.tj",
    "nic.tj",
    "org.tj",
    "test.tj",
    "web.tj",
    "tk",
    "tl",
    "gov.tl",
    "tm",
    "com.tm",
    "co.tm",
    "org.tm",
    "net.tm",
    "nom.tm",
    "gov.tm",
    "mil.tm",
    "edu.tm",
    "tn",
    "com.tn",
    "ens.tn",
    "fin.tn",
    "gov.tn",
    "ind.tn",
    "intl.tn",
    "nat.tn",
    "net.tn",
    "org.tn",
    "info.tn",
    "perso.tn",
    "tourism.tn",
    "edunet.tn",
    "rnrt.tn",
    "rns.tn",
    "rnu.tn",
    "mincom.tn",
    "agrinet.tn",
    "defense.tn",
    "turen.tn",
    "to",
    "com.to",
    "gov.to",
    "net.to",
    "org.to",
    "edu.to",
    "mil.to",
    "tr",
    "av.tr",
    "bbs.tr",
    "bel.tr",
    "biz.tr",
    "com.tr",
    "dr.tr",
    "edu.tr",
    "gen.tr",
    "gov.tr",
    "info.tr",
    "mil.tr",
    "k12.tr",
    "kep.tr",
    "name.tr",
    "net.tr",
    "org.tr",
    "pol.tr",
    "tel.tr",
    "tsk.tr",
    "tv.tr",
    "web.tr",
    "nc.tr",
    "gov.nc.tr",
    "tt",
    "co.tt",
    "com.tt",
    "org.tt",
    "net.tt",
    "biz.tt",
    "info.tt",
    "pro.tt",
    "int.tt",
    "coop.tt",
    "jobs.tt",
    "mobi.tt",
    "travel.tt",
    "museum.tt",
    "aero.tt",
    "name.tt",
    "gov.tt",
    "edu.tt",
    "tv",
    "tw",
    "edu.tw",
    "gov.tw",
    "mil.tw",
    "com.tw",
    "net.tw",
    "org.tw",
    "idv.tw",
    "game.tw",
    "ebiz.tw",
    "club.tw",
    "網路.tw",
    "組織.tw",
    "商業.tw",
    "tz",
    "ac.tz",
    "co.tz",
    "go.tz",
    "hotel.tz",
    "info.tz",
    "me.tz",
    "mil.tz",
    "mobi.tz",
    "ne.tz",
    "or.tz",
    "sc.tz",
    "tv.tz",
    "ua",
    "com.ua",
    "edu.ua",
    "gov.ua",
    "in.ua",
    "net.ua",
    "org.ua",
    "cherkassy.ua",
    "cherkasy.ua",
    "chernigov.ua",
    "chernihiv.ua",
    "chernivtsi.ua",
    "chernovtsy.ua",
    "ck.ua",
    "cn.ua",
    "cr.ua",
    "crimea.ua",
    "cv.ua",
    "dn.ua",
    "dnepropetrovsk.ua",
    "dnipropetrovsk.ua",
    "dominic.ua",
    "donetsk.ua",
    "dp.ua",
    "if.ua",
    "ivano-frankivsk.ua",
    "kh.ua",
    "kharkiv.ua",
    "kharkov.ua",
    "kherson.ua",
    "khmelnitskiy.ua",
    "khmelnytskyi.ua",
    "kiev.ua",
    "kirovograd.ua",
    "km.ua",
    "kr.ua",
    "krym.ua",
    "ks.ua",
    "kv.ua",
    "kyiv.ua",
    "lg.ua",
    "lt.ua",
    "lugansk.ua",
    "lutsk.ua",
    "lv.ua",
    "lviv.ua",
    "mk.ua",
    "mykolaiv.ua",
    "nikolaev.ua",
    "od.ua",
    "odesa.ua",
    "odessa.ua",
    "pl.ua",
    "poltava.ua",
    "rivne.ua",
    "rovno.ua",
    "rv.ua",
    "sb.ua",
    "sebastopol.ua",
    "sevastopol.ua",
    "sm.ua",
    "sumy.ua",
    "te.ua",
    "ternopil.ua",
    "uz.ua",
    "uzhgorod.ua",
    "vinnica.ua",
    "vinnytsia.ua",
    "vn.ua",
    "volyn.ua",
    "yalta.ua",
    "zaporizhzhe.ua",
    "zaporizhzhia.ua",
    "zhitomir.ua",
    "zhytomyr.ua",
    "zp.ua",
    "zt.ua",
    "ug",
    "co.ug",
    "or.ug",
    "ac.ug",
    "sc.ug",
    "go.ug",
    "ne.ug",
    "com.ug",
    "org.ug",
    "uk",
    "ac.uk",
    "co.uk",
    "gov.uk",
    "ltd.uk",
    "me.uk",
    "net.uk",
    "nhs.uk",
    "org.uk",
    "plc.uk",
    "police.uk",
    "*.sch.uk",
    "us",
    "dni.us",
    "fed.us",
    "isa.us",
    "kids.us",
    "nsn.us",
    "ak.us",
    "al.us",
    "ar.us",
    "as.us",
    "az.us",
    "ca.us",
    "co.us",
    "ct.us",
    "dc.us",
    "de.us",
    "fl.us",
    "ga.us",
    "gu.us",
    "hi.us",
    "ia.us",
    "id.us",
    "il.us",
    "in.us",
    "ks.us",
    "ky.us",
    "la.us",
    "ma.us",
    "md.us",
    "me.us",
    "mi.us",
    "mn.us",
    "mo.us",
    "ms.us",
    "mt.us",
    "nc.us",
    "nd.us",
    "ne.us",
    "nh.us",
    "nj.us",
    "nm.us",
    "nv.us",
    "ny.us",
    "oh.us",
    "ok.us",
    "or.us",
    "pa.us",
    "pr.us",
    "ri.us",
    "sc.us",
    "sd.us",
    "tn.us",
    "tx.us",
    "ut.us",
    "vi.us",
    "vt.us",
    "va.us",
    "wa.us",
    "wi.us",
    "wv.us",
    "wy.us",
    "k12.ak.us",
    "k12.al.us",
    "k12.ar.us",
    "k12.as.us",
    "k12.az.us",
    "k12.ca.us",
    "k12.co.us",
    "k12.ct.us",
    "k12.dc.us",
    "k12.de.us",
    "k12.fl.us",
    "k12.ga.us",
    "k12.gu.us",
    "k12.ia.us",
    "k12.id.us",
    "k12.il.us",
    "k12.in.us",
    "k12.ks.us",
    "k12.ky.us",
    "k12.la.us",
    "k12.ma.us",
    "k12.md.us",
    "k12.me.us",
    "k12.mi.us",
    "k12.mn.us",
    "k12.mo.us",
    "k12.ms.us",
    "k12.mt.us",
    "k12.nc.us",
    "k12.ne.us",
    "k12.nh.us",
    "k12.nj.us",
    "k12.nm.us",
    "k12.nv.us",
    "k12.ny.us",
    "k12.oh.us",
    "k12.ok.us",
    "k12.or.us",
    "k12.pa.us",
    "k12.pr.us",
    "k12.ri.us",
    "k12.sc.us",
    "k12.tn.us",
    "k12.tx.us",
    "k12.ut.us",
    "k12.vi.us",
    "k12.vt.us",
    "k12.va.us",
    "k12.wa.us",
    "k12.wi.us",
    "k12.wy.us",
    "cc.ak.us",
    "cc.al.us",
    "cc.ar.us",
    "cc.as.us",
    "cc.az.us",
    "cc.ca.us",
    "cc.co.us",
    "cc.ct.us",
    "cc.dc.us",
    "cc.de.us",
    "cc.fl.us",
    "cc.ga.us",
    "cc.gu.us",
    "cc.hi.us",
    "cc.ia.us",
    "cc.id.us",
    "cc.il.us",
    "cc.in.us",
    "cc.ks.us",
    "cc.ky.us",
    "cc.la.us",
    "cc.ma.us",
    "cc.md.us",
    "cc.me.us",
    "cc.mi.us",
    "cc.mn.us",
    "cc.mo.us",
    "cc.ms.us",
    "cc.mt.us",
    "cc.nc.us",
    "cc.nd.us",
    "cc.ne.us",
    "cc.nh.us",
    "cc.nj.us",
    "cc.nm.us",
    "cc.nv.us",
    "cc.ny.us",
    "cc.oh.us",
    "cc.ok.us",
    "cc.or.us",
    "cc.pa.us",
    "cc.pr.us",
    "cc.ri.us",
    "cc.sc.us",
    "cc.sd.us",
    "cc.tn.us",
    "cc.tx.us",
    "cc.ut.us",
    "cc.vi.us",
    "cc.vt.us",
    "cc.va.us",
    "cc.wa.us",
    "cc.wi.us",
    "cc.wv.us",
    "cc.wy.us",
    "lib.ak.us",
    "lib.al.us",
    "lib.ar.us",
    "lib.as.us",
    "lib.az.us",
    "lib.ca.us",
    "lib.co.us",
    "lib.ct.us",
    "lib.dc.us",
    "lib.fl.us",
    "lib.ga.us",
    "lib.gu.us",
    "lib.hi.us",
    "lib.ia.us",
    "lib.id.us",
    "lib.il.us",
    "lib.in.us",
    "lib.ks.us",
    "lib.ky.us",
    "lib.la.us",
    "lib.ma.us",
    "lib.md.us",
    "lib.me.us",
    "lib.mi.us",
    "lib.mn.us",
    "lib.mo.us",
    "lib.ms.us",
    "lib.mt.us",
    "lib.nc.us",
    "lib.nd.us",
    "lib.ne.us",
    "lib.nh.us",
    "lib.nj.us",
    "lib.nm.us",
    "lib.nv.us",
    "lib.ny.us",
    "lib.oh.us",
    "lib.ok.us",
    "lib.or.us",
    "lib.pa.us",
    "lib.pr.us",
    "lib.ri.us",
    "lib.sc.us",
    "lib.sd.us",
    "lib.tn.us",
    "lib.tx.us",
    "lib.ut.us",
    "lib.vi.us",
    "lib.vt.us",
    "lib.va.us",
    "lib.wa.us",
    "lib.wi.us",
    "lib.wy.us",
    "pvt.k12.ma.us",
    "chtr.k12.ma.us",
    "paroch.k12.ma.us",
    "ann-arbor.mi.us",
    "cog.mi.us",
    "dst.mi.us",
    "eaton.mi.us",
    "gen.mi.us",
    "mus.mi.us",
    "tec.mi.us",
    "washtenaw.mi.us",
    "uy",
    "com.uy",
    "edu.uy",
    "gub.uy",
    "mil.uy",
    "net.uy",
    "org.uy",
    "uz",
    "co.uz",
    "com.uz",
    "net.uz",
    "org.uz",
    "va",
    "vc",
    "com.vc",
    "net.vc",
    "org.vc",
    "gov.vc",
    "mil.vc",
    "edu.vc",
    "ve",
    "arts.ve",
    "co.ve",
    "com.ve",
    "e12.ve",
    "edu.ve",
    "firm.ve",
    "gob.ve",
    "gov.ve",
    "info.ve",
    "int.ve",
    "mil.ve",
    "net.ve",
    "org.ve",
    "rec.ve",
    "store.ve",
    "tec.ve",
    "web.ve",
    "vg",
    "vi",
    "co.vi",
    "com.vi",
    "k12.vi",
    "net.vi",
    "org.vi",
    "vn",
    "com.vn",
    "net.vn",
    "org.vn",
    "edu.vn",
    "gov.vn",
    "int.vn",
    "ac.vn",
    "biz.vn",
    "info.vn",
    "name.vn",
    "pro.vn",
    "health.vn",
    "vu",
    "com.vu",
    "edu.vu",
    "net.vu",
    "org.vu",
    "wf",
    "ws",
    "com.ws",
    "net.ws",
    "org.ws",
    "gov.ws",
    "edu.ws",
    "yt",
    "امارات",
    "հայ",
    "বাংলা",
    "бг",
    "бел",
    "中国",
    "中國",
    "الجزائر",
    "مصر",
    "ею",
    "موريتانيا",
    "გე",
    "ελ",
    "香港",
    "公司.香港",
    "教育.香港",
    "政府.香港",
    "個人.香港",
    "網絡.香港",
    "組織.香港",
    "ಭಾರತ",
    "ଭାରତ",
    "ভাৰত",
    "भारतम्",
    "भारोत",
    "ڀارت",
    "ഭാരതം",
    "भारत",
    "بارت",
    "بھارت",
    "భారత్",
    "ભારત",
    "ਭਾਰਤ",
    "ভারত",
    "இந்தியா",
    "ایران",
    "ايران",
    "عراق",
    "الاردن",
    "한국",
    "қаз",
    "ලංකා",
    "இலங்கை",
    "المغرب",
    "мкд",
    "мон",
    "澳門",
    "澳门",
    "مليسيا",
    "عمان",
    "پاکستان",
    "پاكستان",
    "فلسطين",
    "срб",
    "пр.срб",
    "орг.срб",
    "обр.срб",
    "од.срб",
    "упр.срб",
    "ак.срб",
    "рф",
    "قطر",
    "السعودية",
    "السعودیة",
    "السعودیۃ",
    "السعوديه",
    "سودان",
    "新加坡",
    "சிங்கப்பூர்",
    "سورية",
    "سوريا",
    "ไทย",
    "ศึกษา.ไทย",
    "ธุรกิจ.ไทย",
    "รัฐบาล.ไทย",
    "ทหาร.ไทย",
    "เน็ต.ไทย",
    "องค์กร.ไทย",
    "تونس",
    "台灣",
    "台湾",
    "臺灣",
    "укр",
    "اليمن",
    "xxx",
    "*.ye",
    "ac.za",
    "agric.za",
    "alt.za",
    "co.za",
    "edu.za",
    "gov.za",
    "grondar.za",
    "law.za",
    "mil.za",
    "net.za",
    "ngo.za",
    "nic.za",
    "nis.za",
    "nom.za",
    "org.za",
    "school.za",
    "tm.za",
    "web.za",
    "zm",
    "ac.zm",
    "biz.zm",
    "co.zm",
    "com.zm",
    "edu.zm",
    "gov.zm",
    "info.zm",
    "mil.zm",
    "net.zm",
    "org.zm",
    "sch.zm",
    "zw",
    "ac.zw",
    "co.zw",
    "gov.zw",
    "mil.zw",
    "org.zw",
    "aaa",
    "aarp",
    "abarth",
    "abb",
    "abbott",
    "abbvie",
    "abc",
    "able",
    "abogado",
    "abudhabi",
    "academy",
    "accenture",
    "accountant",
    "accountants",
    "aco",
    "actor",
    "adac",
    "ads",
    "adult",
    "aeg",
    "aetna",
    "afamilycompany",
    "afl",
    "africa",
    "agakhan",
    "agency",
    "aig",
    "aigo",
    "airbus",
    "airforce",
    "airtel",
    "akdn",
    "alfaromeo",
    "alibaba",
    "alipay",
    "allfinanz",
    "allstate",
    "ally",
    "alsace",
    "alstom",
    "americanexpress",
    "americanfamily",
    "amex",
    "amfam",
    "amica",
    "amsterdam",
    "analytics",
    "android",
    "anquan",
    "anz",
    "aol",
    "apartments",
    "app",
    "apple",
    "aquarelle",
    "arab",
    "aramco",
    "archi",
    "army",
    "art",
    "arte",
    "asda",
    "associates",
    "athleta",
    "attorney",
    "auction",
    "audi",
    "audible",
    "audio",
    "auspost",
    "author",
    "auto",
    "autos",
    "avianca",
    "aws",
    "axa",
    "azure",
    "baby",
    "baidu",
    "banamex",
    "bananarepublic",
    "band",
    "bank",
    "bar",
    "barcelona",
    "barclaycard",
    "barclays",
    "barefoot",
    "bargains",
    "baseball",
    "basketball",
    "bauhaus",
    "bayern",
    "bbc",
    "bbt",
    "bbva",
    "bcg",
    "bcn",
    "beats",
    "beauty",
    "beer",
    "bentley",
    "berlin",
    "best",
    "bestbuy",
    "bet",
    "bharti",
    "bible",
    "bid",
    "bike",
    "bing",
    "bingo",
    "bio",
    "black",
    "blackfriday",
    "blockbuster",
    "blog",
    "bloomberg",
    "blue",
    "bms",
    "bmw",
    "bnpparibas",
    "boats",
    "boehringer",
    "bofa",
    "bom",
    "bond",
    "boo",
    "book",
    "booking",
    "bosch",
    "bostik",
    "boston",
    "bot",
    "boutique",
    "box",
    "bradesco",
    "bridgestone",
    "broadway",
    "broker",
    "brother",
    "brussels",
    "budapest",
    "bugatti",
    "build",
    "builders",
    "business",
    "buy",
    "buzz",
    "bzh",
    "cab",
    "cafe",
    "cal",
    "call",
    "calvinklein",
    "cam",
    "camera",
    "camp",
    "cancerresearch",
    "canon",
    "capetown",
    "capital",
    "capitalone",
    "car",
    "caravan",
    "cards",
    "care",
    "career",
    "careers",
    "cars",
    "cartier",
    "casa",
    "case",
    "caseih",
    "cash",
    "casino",
    "catering",
    "catholic",
    "cba",
    "cbn",
    "cbre",
    "cbs",
    "ceb",
    "center",
    "ceo",
    "cern",
    "cfa",
    "cfd",
    "chanel",
    "channel",
    "charity",
    "chase",
    "chat",
    "cheap",
    "chintai",
    "christmas",
    "chrome",
    "chrysler",
    "church",
    "cipriani",
    "circle",
    "cisco",
    "citadel",
    "citi",
    "citic",
    "city",
    "cityeats",
    "claims",
    "cleaning",
    "click",
    "clinic",
    "clinique",
    "clothing",
    "cloud",
    "club",
    "clubmed",
    "coach",
    "codes",
    "coffee",
    "college",
    "cologne",
    "comcast",
    "commbank",
    "community",
    "company",
    "compare",
    "computer",
    "comsec",
    "condos",
    "construction",
    "consulting",
    "contact",
    "contractors",
    "cooking",
    "cookingchannel",
    "cool",
    "corsica",
    "country",
    "coupon",
    "coupons",
    "courses",
    "cpa",
    "credit",
    "creditcard",
    "creditunion",
    "cricket",
    "crown",
    "crs",
    "cruise",
    "cruises",
    "csc",
    "cuisinella",
    "cymru",
    "cyou",
    "dabur",
    "dad",
    "dance",
    "data",
    "date",
    "dating",
    "datsun",
    "day",
    "dclk",
    "dds",
    "deal",
    "dealer",
    "deals",
    "degree",
    "delivery",
    "dell",
    "deloitte",
    "delta",
    "democrat",
    "dental",
    "dentist",
    "desi",
    "design",
    "dev",
    "dhl",
    "diamonds",
    "diet",
    "digital",
    "direct",
    "directory",
    "discount",
    "discover",
    "dish",
    "diy",
    "dnp",
    "docs",
    "doctor",
    "dodge",
    "dog",
    "domains",
    "dot",
    "download",
    "drive",
    "dtv",
    "dubai",
    "duck",
    "dunlop",
    "dupont",
    "durban",
    "dvag",
    "dvr",
    "earth",
    "eat",
    "eco",
    "edeka",
    "education",
    "email",
    "emerck",
    "energy",
    "engineer",
    "engineering",
    "enterprises",
    "epson",
    "equipment",
    "ericsson",
    "erni",
    "esq",
    "estate",
    "esurance",
    "etisalat",
    "eurovision",
    "eus",
    "events",
    "everbank",
    "exchange",
    "expert",
    "exposed",
    "express",
    "extraspace",
    "fage",
    "fail",
    "fairwinds",
    "faith",
    "family",
    "fan",
    "fans",
    "farm",
    "farmers",
    "fashion",
    "fast",
    "fedex",
    "feedback",
    "ferrari",
    "ferrero",
    "fiat",
    "fidelity",
    "fido",
    "film",
    "final",
    "finance",
    "financial",
    "fire",
    "firestone",
    "firmdale",
    "fish",
    "fishing",
    "fit",
    "fitness",
    "flickr",
    "flights",
    "flir",
    "florist",
    "flowers",
    "fly",
    "foo",
    "food",
    "foodnetwork",
    "football",
    "ford",
    "forex",
    "forsale",
    "forum",
    "foundation",
    "fox",
    "free",
    "fresenius",
    "frl",
    "frogans",
    "frontdoor",
    "frontier",
    "ftr",
    "fujitsu",
    "fujixerox",
    "fun",
    "fund",
    "furniture",
    "futbol",
    "fyi",
    "gal",
    "gallery",
    "gallo",
    "gallup",
    "game",
    "games",
    "gap",
    "garden",
    "gay",
    "gbiz",
    "gdn",
    "gea",
    "gent",
    "genting",
    "george",
    "ggee",
    "gift",
    "gifts",
    "gives",
    "giving",
    "glade",
    "glass",
    "gle",
    "global",
    "globo",
    "gmail",
    "gmbh",
    "gmo",
    "gmx",
    "godaddy",
    "gold",
    "goldpoint",
    "golf",
    "goo",
    "goodyear",
    "goog",
    "google",
    "gop",
    "got",
    "grainger",
    "graphics",
    "gratis",
    "green",
    "gripe",
    "grocery",
    "group",
    "guardian",
    "gucci",
    "guge",
    "guide",
    "guitars",
    "guru",
    "hair",
    "hamburg",
    "hangout",
    "haus",
    "hbo",
    "hdfc",
    "hdfcbank",
    "health",
    "healthcare",
    "help",
    "helsinki",
    "here",
    "hermes",
    "hgtv",
    "hiphop",
    "hisamitsu",
    "hitachi",
    "hiv",
    "hkt",
    "hockey",
    "holdings",
    "holiday",
    "homedepot",
    "homegoods",
    "homes",
    "homesense",
    "honda",
    "horse",
    "hospital",
    "host",
    "hosting",
    "hot",
    "hoteles",
    "hotels",
    "hotmail",
    "house",
    "how",
    "hsbc",
    "hughes",
    "hyatt",
    "hyundai",
    "ibm",
    "icbc",
    "ice",
    "icu",
    "ieee",
    "ifm",
    "ikano",
    "imamat",
    "imdb",
    "immo",
    "immobilien",
    "inc",
    "industries",
    "infiniti",
    "ing",
    "ink",
    "institute",
    "insurance",
    "insure",
    "intel",
    "international",
    "intuit",
    "investments",
    "ipiranga",
    "irish",
    "ismaili",
    "ist",
    "istanbul",
    "itau",
    "itv",
    "iveco",
    "jaguar",
    "java",
    "jcb",
    "jcp",
    "jeep",
    "jetzt",
    "jewelry",
    "jio",
    "jll",
    "jmp",
    "jnj",
    "joburg",
    "jot",
    "joy",
    "jpmorgan",
    "jprs",
    "juegos",
    "juniper",
    "kaufen",
    "kddi",
    "kerryhotels",
    "kerrylogistics",
    "kerryproperties",
    "kfh",
    "kia",
    "kim",
    "kinder",
    "kindle",
    "kitchen",
    "kiwi",
    "koeln",
    "komatsu",
    "kosher",
    "kpmg",
    "kpn",
    "krd",
    "kred",
    "kuokgroup",
    "kyoto",
    "lacaixa",
    "ladbrokes",
    "lamborghini",
    "lamer",
    "lancaster",
    "lancia",
    "lancome",
    "land",
    "landrover",
    "lanxess",
    "lasalle",
    "lat",
    "latino",
    "latrobe",
    "law",
    "lawyer",
    "lds",
    "lease",
    "leclerc",
    "lefrak",
    "legal",
    "lego",
    "lexus",
    "lgbt",
    "liaison",
    "lidl",
    "life",
    "lifeinsurance",
    "lifestyle",
    "lighting",
    "like",
    "lilly",
    "limited",
    "limo",
    "lincoln",
    "linde",
    "link",
    "lipsy",
    "live",
    "living",
    "lixil",
    "llc",
    "llp",
    "loan",
    "loans",
    "locker",
    "locus",
    "loft",
    "lol",
    "london",
    "lotte",
    "lotto",
    "love",
    "lpl",
    "lplfinancial",
    "ltd",
    "ltda",
    "lundbeck",
    "lupin",
    "luxe",
    "luxury",
    "macys",
    "madrid",
    "maif",
    "maison",
    "makeup",
    "man",
    "management",
    "mango",
    "map",
    "market",
    "marketing",
    "markets",
    "marriott",
    "marshalls",
    "maserati",
    "mattel",
    "mba",
    "mckinsey",
    "med",
    "media",
    "meet",
    "melbourne",
    "meme",
    "memorial",
    "men",
    "menu",
    "merckmsd",
    "metlife",
    "miami",
    "microsoft",
    "mini",
    "mint",
    "mit",
    "mitsubishi",
    "mlb",
    "mls",
    "mma",
    "mobile",
    "moda",
    "moe",
    "moi",
    "mom",
    "monash",
    "money",
    "monster",
    "mopar",
    "mormon",
    "mortgage",
    "moscow",
    "moto",
    "motorcycles",
    "mov",
    "movie",
    "movistar",
    "msd",
    "mtn",
    "mtr",
    "mutual",
    "nab",
    "nadex",
    "nagoya",
    "nationwide",
    "natura",
    "navy",
    "nba",
    "nec",
    "netbank",
    "netflix",
    "network",
    "neustar",
    "new",
    "newholland",
    "news",
    "next",
    "nextdirect",
    "nexus",
    "nfl",
    "ngo",
    "nhk",
    "nico",
    "nike",
    "nikon",
    "ninja",
    "nissan",
    "nissay",
    "nokia",
    "northwesternmutual",
    "norton",
    "now",
    "nowruz",
    "nowtv",
    "nra",
    "nrw",
    "ntt",
    "nyc",
    "obi",
    "observer",
    "off",
    "office",
    "okinawa",
    "olayan",
    "olayangroup",
    "oldnavy",
    "ollo",
    "omega",
    "one",
    "ong",
    "onl",
    "online",
    "onyourside",
    "ooo",
    "open",
    "oracle",
    "orange",
    "organic",
    "origins",
    "osaka",
    "otsuka",
    "ott",
    "ovh",
    "page",
    "panasonic",
    "paris",
    "pars",
    "partners",
    "parts",
    "party",
    "passagens",
    "pay",
    "pccw",
    "pet",
    "pfizer",
    "pharmacy",
    "phd",
    "philips",
    "phone",
    "photo",
    "photography",
    "photos",
    "physio",
    "piaget",
    "pics",
    "pictet",
    "pictures",
    "pid",
    "pin",
    "ping",
    "pink",
    "pioneer",
    "pizza",
    "place",
    "play",
    "playstation",
    "plumbing",
    "plus",
    "pnc",
    "pohl",
    "poker",
    "politie",
    "porn",
    "pramerica",
    "praxi",
    "press",
    "prime",
    "prod",
    "productions",
    "prof",
    "progressive",
    "promo",
    "properties",
    "property",
    "protection",
    "pru",
    "prudential",
    "pub",
    "pwc",
    "qpon",
    "quebec",
    "quest",
    "qvc",
    "racing",
    "radio",
    "raid",
    "read",
    "realestate",
    "realtor",
    "realty",
    "recipes",
    "red",
    "redstone",
    "redumbrella",
    "rehab",
    "reise",
    "reisen",
    "reit",
    "reliance",
    "ren",
    "rent",
    "rentals",
    "repair",
    "report",
    "republican",
    "rest",
    "restaurant",
    "review",
    "reviews",
    "rexroth",
    "rich",
    "richardli",
    "ricoh",
    "rightathome",
    "ril",
    "rio",
    "rip",
    "rmit",
    "rocher",
    "rocks",
    "rodeo",
    "rogers",
    "room",
    "rsvp",
    "rugby",
    "ruhr",
    "run",
    "rwe",
    "ryukyu",
    "saarland",
    "safe",
    "safety",
    "sakura",
    "sale",
    "salon",
    "samsclub",
    "samsung",
    "sandvik",
    "sandvikcoromant",
    "sanofi",
    "sap",
    "sarl",
    "sas",
    "save",
    "saxo",
    "sbi",
    "sbs",
    "sca",
    "scb",
    "schaeffler",
    "schmidt",
    "scholarships",
    "school",
    "schule",
    "schwarz",
    "science",
    "scjohnson",
    "scor",
    "scot",
    "search",
    "seat",
    "secure",
    "security",
    "seek",
    "select",
    "sener",
    "services",
    "ses",
    "seven",
    "sew",
    "sex",
    "sexy",
    "sfr",
    "shangrila",
    "sharp",
    "shaw",
    "shell",
    "shia",
    "shiksha",
    "shoes",
    "shop",
    "shopping",
    "shouji",
    "show",
    "showtime",
    "shriram",
    "silk",
    "sina",
    "singles",
    "site",
    "ski",
    "skin",
    "sky",
    "skype",
    "sling",
    "smart",
    "smile",
    "sncf",
    "soccer",
    "social",
    "softbank",
    "software",
    "sohu",
    "solar",
    "solutions",
    "song",
    "sony",
    "soy",
    "spa",
    "space",
    "sport",
    "spot",
    "spreadbetting",
    "srl",
    "srt",
    "stada",
    "staples",
    "star",
    "statebank",
    "statefarm",
    "stc",
    "stcgroup",
    "stockholm",
    "storage",
    "store",
    "stream",
    "studio",
    "study",
    "style",
    "sucks",
    "supplies",
    "supply",
    "support",
    "surf",
    "surgery",
    "suzuki",
    "swatch",
    "swiftcover",
    "swiss",
    "sydney",
    "symantec",
    "systems",
    "tab",
    "taipei",
    "talk",
    "taobao",
    "target",
    "tatamotors",
    "tatar",
    "tattoo",
    "tax",
    "taxi",
    "tci",
    "tdk",
    "team",
    "tech",
    "technology",
    "telefonica",
    "temasek",
    "tennis",
    "teva",
    "thd",
    "theater",
    "theatre",
    "tiaa",
    "tickets",
    "tienda",
    "tiffany",
    "tips",
    "tires",
    "tirol",
    "tjmaxx",
    "tjx",
    "tkmaxx",
    "tmall",
    "today",
    "tokyo",
    "tools",
    "top",
    "toray",
    "toshiba",
    "total",
    "tours",
    "town",
    "toyota",
    "toys",
    "trade",
    "trading",
    "training",
    "travel",
    "travelchannel",
    "travelers",
    "travelersinsurance",
    "trust",
    "trv",
    "tube",
    "tui",
    "tunes",
    "tushu",
    "tvs",
    "ubank",
    "ubs",
    "uconnect",
    "unicom",
    "university",
    "uno",
    "uol",
    "ups",
    "vacations",
    "vana",
    "vanguard",
    "vegas",
    "ventures",
    "verisign",
    "versicherung",
    "vet",
    "viajes",
    "video",
    "vig",
    "viking",
    "villas",
    "vin",
    "vip",
    "virgin",
    "visa",
    "vision",
    "vistaprint",
    "viva",
    "vivo",
    "vlaanderen",
    "vodka",
    "volkswagen",
    "volvo",
    "vote",
    "voting",
    "voto",
    "voyage",
    "vuelos",
    "wales",
    "walmart",
    "walter",
    "wang",
    "wanggou",
    "warman",
    "watch",
    "watches",
    "weather",
    "weatherchannel",
    "webcam",
    "weber",
    "website",
    "wed",
    "wedding",
    "weibo",
    "weir",
    "whoswho",
    "wien",
    "wiki",
    "williamhill",
    "win",
    "windows",
    "wine",
    "winners",
    "wme",
    "wolterskluwer",
    "woodside",
    "work",
    "works",
    "world",
    "wow",
    "wtc",
    "wtf",
    "xbox",
    "xerox",
    "xfinity",
    "xihuan",
    "xin",
    "कॉम",
    "セール",
    "佛山",
    "慈善",
    "集团",
    "在线",
    "大众汽车",
    "点看",
    "คอม",
    "八卦",
    "موقع",
    "公益",
    "公司",
    "香格里拉",
    "网站",
    "移动",
    "我爱你",
    "москва",
    "католик",
    "онлайн",
    "сайт",
    "联通",
    "קום",
    "时尚",
    "微博",
    "淡马锡",
    "ファッション",
    "орг",
    "नेट",
    "ストア",
    "삼성",
    "商标",
    "商店",
    "商城",
    "дети",
    "ポイント",
    "新闻",
    "工行",
    "家電",
    "كوم",
    "中文网",
    "中信",
    "娱乐",
    "谷歌",
    "電訊盈科",
    "购物",
    "クラウド",
    "通販",
    "网店",
    "संगठन",
    "餐厅",
    "网络",
    "ком",
    "诺基亚",
    "食品",
    "飞利浦",
    "手表",
    "手机",
    "ارامكو",
    "العليان",
    "اتصالات",
    "بازار",
    "ابوظبي",
    "كاثوليك",
    "همراه",
    "닷컴",
    "政府",
    "شبكة",
    "بيتك",
    "عرب",
    "机构",
    "组织机构",
    "健康",
    "招聘",
    "рус",
    "珠宝",
    "大拿",
    "みんな",
    "グーグル",
    "世界",
    "書籍",
    "网址",
    "닷넷",
    "コム",
    "天主教",
    "游戏",
    "vermögensberater",
    "vermögensberatung",
    "企业",
    "信息",
    "嘉里大酒店",
    "嘉里",
    "广东",
    "政务",
    "xyz",
    "yachts",
    "yahoo",
    "yamaxun",
    "yandex",
    "yodobashi",
    "yoga",
    "yokohama",
    "you",
    "youtube",
    "yun",
    "zappos",
    "zara",
    "zero",
    "zip",
    "zone",
    "zuerich",
    "cc.ua",
    "inf.ua",
    "ltd.ua",
    "beep.pl",
    "barsy.ca",
    "*.compute.estate",
    "*.alces.network",
    "altervista.org",
    "alwaysdata.net",
    "cloudfront.net",
    "*.compute.amazonaws.com",
    "*.compute-1.amazonaws.com",
    "*.compute.amazonaws.com.cn",
    "us-east-1.amazonaws.com",
    "cn-north-1.eb.amazonaws.com.cn",
    "cn-northwest-1.eb.amazonaws.com.cn",
    "elasticbeanstalk.com",
    "ap-northeast-1.elasticbeanstalk.com",
    "ap-northeast-2.elasticbeanstalk.com",
    "ap-northeast-3.elasticbeanstalk.com",
    "ap-south-1.elasticbeanstalk.com",
    "ap-southeast-1.elasticbeanstalk.com",
    "ap-southeast-2.elasticbeanstalk.com",
    "ca-central-1.elasticbeanstalk.com",
    "eu-central-1.elasticbeanstalk.com",
    "eu-west-1.elasticbeanstalk.com",
    "eu-west-2.elasticbeanstalk.com",
    "eu-west-3.elasticbeanstalk.com",
    "sa-east-1.elasticbeanstalk.com",
    "us-east-1.elasticbeanstalk.com",
    "us-east-2.elasticbeanstalk.com",
    "us-gov-west-1.elasticbeanstalk.com",
    "us-west-1.elasticbeanstalk.com",
    "us-west-2.elasticbeanstalk.com",
    "*.elb.amazonaws.com",
    "*.elb.amazonaws.com.cn",
    "s3.amazonaws.com",
    "s3-ap-northeast-1.amazonaws.com",
    "s3-ap-northeast-2.amazonaws.com",
    "s3-ap-south-1.amazonaws.com",
    "s3-ap-southeast-1.amazonaws.com",
    "s3-ap-southeast-2.amazonaws.com",
    "s3-ca-central-1.amazonaws.com",
    "s3-eu-central-1.amazonaws.com",
    "s3-eu-west-1.amazonaws.com",
    "s3-eu-west-2.amazonaws.com",
    "s3-eu-west-3.amazonaws.com",
    "s3-external-1.amazonaws.com",
    "s3-fips-us-gov-west-1.amazonaws.com",
    "s3-sa-east-1.amazonaws.com",
    "s3-us-gov-west-1.amazonaws.com",
    "s3-us-east-2.amazonaws.com",
    "s3-us-west-1.amazonaws.com",
    "s3-us-west-2.amazonaws.com",
    "s3.ap-northeast-2.amazonaws.com",
    "s3.ap-south-1.amazonaws.com",
    "s3.cn-north-1.amazonaws.com.cn",
    "s3.ca-central-1.amazonaws.com",
    "s3.eu-central-1.amazonaws.com",
    "s3.eu-west-2.amazonaws.com",
    "s3.eu-west-3.amazonaws.com",
    "s3.us-east-2.amazonaws.com",
    "s3.dualstack.ap-northeast-1.amazonaws.com",
    "s3.dualstack.ap-northeast-2.amazonaws.com",
    "s3.dualstack.ap-south-1.amazonaws.com",
    "s3.dualstack.ap-southeast-1.amazonaws.com",
    "s3.dualstack.ap-southeast-2.amazonaws.com",
    "s3.dualstack.ca-central-1.amazonaws.com",
    "s3.dualstack.eu-central-1.amazonaws.com",
    "s3.dualstack.eu-west-1.amazonaws.com",
    "s3.dualstack.eu-west-2.amazonaws.com",
    "s3.dualstack.eu-west-3.amazonaws.com",
    "s3.dualstack.sa-east-1.amazonaws.com",
    "s3.dualstack.us-east-1.amazonaws.com",
    "s3.dualstack.us-east-2.amazonaws.com",
    "s3-website-us-east-1.amazonaws.com",
    "s3-website-us-west-1.amazonaws.com",
    "s3-website-us-west-2.amazonaws.com",
    "s3-website-ap-northeast-1.amazonaws.com",
    "s3-website-ap-southeast-1.amazonaws.com",
    "s3-website-ap-southeast-2.amazonaws.com",
    "s3-website-eu-west-1.amazonaws.com",
    "s3-website-sa-east-1.amazonaws.com",
    "s3-website.ap-northeast-2.amazonaws.com",
    "s3-website.ap-south-1.amazonaws.com",
    "s3-website.ca-central-1.amazonaws.com",
    "s3-website.eu-central-1.amazonaws.com",
    "s3-website.eu-west-2.amazonaws.com",
    "s3-website.eu-west-3.amazonaws.com",
    "s3-website.us-east-2.amazonaws.com",
    "t3l3p0rt.net",
    "tele.amune.org",
    "apigee.io",
    "on-aptible.com",
    "user.aseinet.ne.jp",
    "gv.vc",
    "d.gv.vc",
    "user.party.eus",
    "pimienta.org",
    "poivron.org",
    "potager.org",
    "sweetpepper.org",
    "myasustor.com",
    "go-vip.co",
    "go-vip.net",
    "wpcomstaging.com",
    "myfritz.net",
    "*.awdev.ca",
    "*.advisor.ws",
    "b-data.io",
    "backplaneapp.io",
    "balena-devices.com",
    "app.banzaicloud.io",
    "betainabox.com",
    "bnr.la",
    "blackbaudcdn.net",
    "boomla.net",
    "boxfuse.io",
    "square7.ch",
    "bplaced.com",
    "bplaced.de",
    "square7.de",
    "bplaced.net",
    "square7.net",
    "browsersafetymark.io",
    "uk0.bigv.io",
    "dh.bytemark.co.uk",
    "vm.bytemark.co.uk",
    "mycd.eu",
    "carrd.co",
    "crd.co",
    "uwu.ai",
    "ae.org",
    "ar.com",
    "br.com",
    "cn.com",
    "com.de",
    "com.se",
    "de.com",
    "eu.com",
    "gb.com",
    "gb.net",
    "hu.com",
    "hu.net",
    "jp.net",
    "jpn.com",
    "kr.com",
    "mex.com",
    "no.com",
    "qc.com",
    "ru.com",
    "sa.com",
    "se.net",
    "uk.com",
    "uk.net",
    "us.com",
    "uy.com",
    "za.bz",
    "za.com",
    "africa.com",
    "gr.com",
    "in.net",
    "us.org",
    "co.com",
    "c.la",
    "certmgr.org",
    "xenapponazure.com",
    "discourse.group",
    "virtueeldomein.nl",
    "cleverapps.io",
    "*.lcl.dev",
    "*.stg.dev",
    "c66.me",
    "cloud66.ws",
    "cloud66.zone",
    "jdevcloud.com",
    "wpdevcloud.com",
    "cloudaccess.host",
    "freesite.host",
    "cloudaccess.net",
    "cloudcontrolled.com",
    "cloudcontrolapp.com",
    "cloudera.site",
    "trycloudflare.com",
    "workers.dev",
    "wnext.app",
    "co.ca",
    "*.otap.co",
    "co.cz",
    "c.cdn77.org",
    "cdn77-ssl.net",
    "r.cdn77.net",
    "rsc.cdn77.org",
    "ssl.origin.cdn77-secure.org",
    "cloudns.asia",
    "cloudns.biz",
    "cloudns.club",
    "cloudns.cc",
    "cloudns.eu",
    "cloudns.in",
    "cloudns.info",
    "cloudns.org",
    "cloudns.pro",
    "cloudns.pw",
    "cloudns.us",
    "cloudeity.net",
    "cnpy.gdn",
    "co.nl",
    "co.no",
    "webhosting.be",
    "hosting-cluster.nl",
    "dyn.cosidns.de",
    "dynamisches-dns.de",
    "dnsupdater.de",
    "internet-dns.de",
    "l-o-g-i-n.de",
    "dynamic-dns.info",
    "feste-ip.net",
    "knx-server.net",
    "static-access.net",
    "realm.cz",
    "*.cryptonomic.net",
    "cupcake.is",
    "cyon.link",
    "cyon.site",
    "daplie.me",
    "localhost.daplie.me",
    "dattolocal.com",
    "dattorelay.com",
    "dattoweb.com",
    "mydatto.com",
    "dattolocal.net",
    "mydatto.net",
    "biz.dk",
    "co.dk",
    "firm.dk",
    "reg.dk",
    "store.dk",
    "*.dapps.earth",
    "*.bzz.dapps.earth",
    "debian.net",
    "dedyn.io",
    "dnshome.de",
    "online.th",
    "shop.th",
    "drayddns.com",
    "dreamhosters.com",
    "mydrobo.com",
    "drud.io",
    "drud.us",
    "duckdns.org",
    "dy.fi",
    "tunk.org",
    "dyndns-at-home.com",
    "dyndns-at-work.com",
    "dyndns-blog.com",
    "dyndns-free.com",
    "dyndns-home.com",
    "dyndns-ip.com",
    "dyndns-mail.com",
    "dyndns-office.com",
    "dyndns-pics.com",
    "dyndns-remote.com",
    "dyndns-server.com",
    "dyndns-web.com",
    "dyndns-wiki.com",
    "dyndns-work.com",
    "dyndns.biz",
    "dyndns.info",
    "dyndns.org",
    "dyndns.tv",
    "at-band-camp.net",
    "ath.cx",
    "barrel-of-knowledge.info",
    "barrell-of-knowledge.info",
    "better-than.tv",
    "blogdns.com",
    "blogdns.net",
    "blogdns.org",
    "blogsite.org",
    "boldlygoingnowhere.org",
    "broke-it.net",
    "buyshouses.net",
    "cechire.com",
    "dnsalias.com",
    "dnsalias.net",
    "dnsalias.org",
    "dnsdojo.com",
    "dnsdojo.net",
    "dnsdojo.org",
    "does-it.net",
    "doesntexist.com",
    "doesntexist.org",
    "dontexist.com",
    "dontexist.net",
    "dontexist.org",
    "doomdns.com",
    "doomdns.org",
    "dvrdns.org",
    "dyn-o-saur.com",
    "dynalias.com",
    "dynalias.net",
    "dynalias.org",
    "dynathome.net",
    "dyndns.ws",
    "endofinternet.net",
    "endofinternet.org",
    "endoftheinternet.org",
    "est-a-la-maison.com",
    "est-a-la-masion.com",
    "est-le-patron.com",
    "est-mon-blogueur.com",
    "for-better.biz",
    "for-more.biz",
    "for-our.info",
    "for-some.biz",
    "for-the.biz",
    "forgot.her.name",
    "forgot.his.name",
    "from-ak.com",
    "from-al.com",
    "from-ar.com",
    "from-az.net",
    "from-ca.com",
    "from-co.net",
    "from-ct.com",
    "from-dc.com",
    "from-de.com",
    "from-fl.com",
    "from-ga.com",
    "from-hi.com",
    "from-ia.com",
    "from-id.com",
    "from-il.com",
    "from-in.com",
    "from-ks.com",
    "from-ky.com",
    "from-la.net",
    "from-ma.com",
    "from-md.com",
    "from-me.org",
    "from-mi.com",
    "from-mn.com",
    "from-mo.com",
    "from-ms.com",
    "from-mt.com",
    "from-nc.com",
    "from-nd.com",
    "from-ne.com",
    "from-nh.com",
    "from-nj.com",
    "from-nm.com",
    "from-nv.com",
    "from-ny.net",
    "from-oh.com",
    "from-ok.com",
    "from-or.com",
    "from-pa.com",
    "from-pr.com",
    "from-ri.com",
    "from-sc.com",
    "from-sd.com",
    "from-tn.com",
    "from-tx.com",
    "from-ut.com",
    "from-va.com",
    "from-vt.com",
    "from-wa.com",
    "from-wi.com",
    "from-wv.com",
    "from-wy.com",
    "ftpaccess.cc",
    "fuettertdasnetz.de",
    "game-host.org",
    "game-server.cc",
    "getmyip.com",
    "gets-it.net",
    "go.dyndns.org",
    "gotdns.com",
    "gotdns.org",
    "groks-the.info",
    "groks-this.info",
    "ham-radio-op.net",
    "here-for-more.info",
    "hobby-site.com",
    "hobby-site.org",
    "home.dyndns.org",
    "homedns.org",
    "homeftp.net",
    "homeftp.org",
    "homeip.net",
    "homelinux.com",
    "homelinux.net",
    "homelinux.org",
    "homeunix.com",
    "homeunix.net",
    "homeunix.org",
    "iamallama.com",
    "in-the-band.net",
    "is-a-anarchist.com",
    "is-a-blogger.com",
    "is-a-bookkeeper.com",
    "is-a-bruinsfan.org",
    "is-a-bulls-fan.com",
    "is-a-candidate.org",
    "is-a-caterer.com",
    "is-a-celticsfan.org",
    "is-a-chef.com",
    "is-a-chef.net",
    "is-a-chef.org",
    "is-a-conservative.com",
    "is-a-cpa.com",
    "is-a-cubicle-slave.com",
    "is-a-democrat.com",
    "is-a-designer.com",
    "is-a-doctor.com",
    "is-a-financialadvisor.com",
    "is-a-geek.com",
    "is-a-geek.net",
    "is-a-geek.org",
    "is-a-green.com",
    "is-a-guru.com",
    "is-a-hard-worker.com",
    "is-a-hunter.com",
    "is-a-knight.org",
    "is-a-landscaper.com",
    "is-a-lawyer.com",
    "is-a-liberal.com",
    "is-a-libertarian.com",
    "is-a-linux-user.org",
    "is-a-llama.com",
    "is-a-musician.com",
    "is-a-nascarfan.com",
    "is-a-nurse.com",
    "is-a-painter.com",
    "is-a-patsfan.org",
    "is-a-personaltrainer.com",
    "is-a-photographer.com",
    "is-a-player.com",
    "is-a-republican.com",
    "is-a-rockstar.com",
    "is-a-socialist.com",
    "is-a-soxfan.org",
    "is-a-student.com",
    "is-a-teacher.com",
    "is-a-techie.com",
    "is-a-therapist.com",
    "is-an-accountant.com",
    "is-an-actor.com",
    "is-an-actress.com",
    "is-an-anarchist.com",
    "is-an-artist.com",
    "is-an-engineer.com",
    "is-an-entertainer.com",
    "is-by.us",
    "is-certified.com",
    "is-found.org",
    "is-gone.com",
    "is-into-anime.com",
    "is-into-cars.com",
    "is-into-cartoons.com",
    "is-into-games.com",
    "is-leet.com",
    "is-lost.org",
    "is-not-certified.com",
    "is-saved.org",
    "is-slick.com",
    "is-uberleet.com",
    "is-very-bad.org",
    "is-very-evil.org",
    "is-very-good.org",
    "is-very-nice.org",
    "is-very-sweet.org",
    "is-with-theband.com",
    "isa-geek.com",
    "isa-geek.net",
    "isa-geek.org",
    "isa-hockeynut.com",
    "issmarterthanyou.com",
    "isteingeek.de",
    "istmein.de",
    "kicks-ass.net",
    "kicks-ass.org",
    "knowsitall.info",
    "land-4-sale.us",
    "lebtimnetz.de",
    "leitungsen.de",
    "likes-pie.com",
    "likescandy.com",
    "merseine.nu",
    "mine.nu",
    "misconfused.org",
    "mypets.ws",
    "myphotos.cc",
    "neat-url.com",
    "office-on-the.net",
    "on-the-web.tv",
    "podzone.net",
    "podzone.org",
    "readmyblog.org",
    "saves-the-whales.com",
    "scrapper-site.net",
    "scrapping.cc",
    "selfip.biz",
    "selfip.com",
    "selfip.info",
    "selfip.net",
    "selfip.org",
    "sells-for-less.com",
    "sells-for-u.com",
    "sells-it.net",
    "sellsyourhome.org",
    "servebbs.com",
    "servebbs.net",
    "servebbs.org",
    "serveftp.net",
    "serveftp.org",
    "servegame.org",
    "shacknet.nu",
    "simple-url.com",
    "space-to-rent.com",
    "stuff-4-sale.org",
    "stuff-4-sale.us",
    "teaches-yoga.com",
    "thruhere.net",
    "traeumtgerade.de",
    "webhop.biz",
    "webhop.info",
    "webhop.net",
    "webhop.org",
    "worse-than.tv",
    "writesthisblog.com",
    "ddnss.de",
    "dyn.ddnss.de",
    "dyndns.ddnss.de",
    "dyndns1.de",
    "dyn-ip24.de",
    "home-webserver.de",
    "dyn.home-webserver.de",
    "myhome-server.de",
    "ddnss.org",
    "definima.net",
    "definima.io",
    "bci.dnstrace.pro",
    "ddnsfree.com",
    "ddnsgeek.com",
    "giize.com",
    "gleeze.com",
    "kozow.com",
    "loseyourip.com",
    "ooguy.com",
    "theworkpc.com",
    "casacam.net",
    "dynu.net",
    "accesscam.org",
    "camdvr.org",
    "freeddns.org",
    "mywire.org",
    "webredirect.org",
    "myddns.rocks",
    "blogsite.xyz",
    "dynv6.net",
    "e4.cz",
    "mytuleap.com",
    "onred.one",
    "staging.onred.one",
    "enonic.io",
    "customer.enonic.io",
    "eu.org",
    "al.eu.org",
    "asso.eu.org",
    "at.eu.org",
    "au.eu.org",
    "be.eu.org",
    "bg.eu.org",
    "ca.eu.org",
    "cd.eu.org",
    "ch.eu.org",
    "cn.eu.org",
    "cy.eu.org",
    "cz.eu.org",
    "de.eu.org",
    "dk.eu.org",
    "edu.eu.org",
    "ee.eu.org",
    "es.eu.org",
    "fi.eu.org",
    "fr.eu.org",
    "gr.eu.org",
    "hr.eu.org",
    "hu.eu.org",
    "ie.eu.org",
    "il.eu.org",
    "in.eu.org",
    "int.eu.org",
    "is.eu.org",
    "it.eu.org",
    "jp.eu.org",
    "kr.eu.org",
    "lt.eu.org",
    "lu.eu.org",
    "lv.eu.org",
    "mc.eu.org",
    "me.eu.org",
    "mk.eu.org",
    "mt.eu.org",
    "my.eu.org",
    "net.eu.org",
    "ng.eu.org",
    "nl.eu.org",
    "no.eu.org",
    "nz.eu.org",
    "paris.eu.org",
    "pl.eu.org",
    "pt.eu.org",
    "q-a.eu.org",
    "ro.eu.org",
    "ru.eu.org",
    "se.eu.org",
    "si.eu.org",
    "sk.eu.org",
    "tr.eu.org",
    "uk.eu.org",
    "us.eu.org",
    "eu-1.evennode.com",
    "eu-2.evennode.com",
    "eu-3.evennode.com",
    "eu-4.evennode.com",
    "us-1.evennode.com",
    "us-2.evennode.com",
    "us-3.evennode.com",
    "us-4.evennode.com",
    "twmail.cc",
    "twmail.net",
    "twmail.org",
    "mymailer.com.tw",
    "url.tw",
    "apps.fbsbx.com",
    "ru.net",
    "adygeya.ru",
    "bashkiria.ru",
    "bir.ru",
    "cbg.ru",
    "com.ru",
    "dagestan.ru",
    "grozny.ru",
    "kalmykia.ru",
    "kustanai.ru",
    "marine.ru",
    "mordovia.ru",
    "msk.ru",
    "mytis.ru",
    "nalchik.ru",
    "nov.ru",
    "pyatigorsk.ru",
    "spb.ru",
    "vladikavkaz.ru",
    "vladimir.ru",
    "abkhazia.su",
    "adygeya.su",
    "aktyubinsk.su",
    "arkhangelsk.su",
    "armenia.su",
    "ashgabad.su",
    "azerbaijan.su",
    "balashov.su",
    "bashkiria.su",
    "bryansk.su",
    "bukhara.su",
    "chimkent.su",
    "dagestan.su",
    "east-kazakhstan.su",
    "exnet.su",
    "georgia.su",
    "grozny.su",
    "ivanovo.su",
    "jambyl.su",
    "kalmykia.su",
    "kaluga.su",
    "karacol.su",
    "karaganda.su",
    "karelia.su",
    "khakassia.su",
    "krasnodar.su",
    "kurgan.su",
    "kustanai.su",
    "lenug.su",
    "mangyshlak.su",
    "mordovia.su",
    "msk.su",
    "murmansk.su",
    "nalchik.su",
    "navoi.su",
    "north-kazakhstan.su",
    "nov.su",
    "obninsk.su",
    "penza.su",
    "pokrovsk.su",
    "sochi.su",
    "spb.su",
    "tashkent.su",
    "termez.su",
    "togliatti.su",
    "troitsk.su",
    "tselinograd.su",
    "tula.su",
    "tuva.su",
    "vladikavkaz.su",
    "vladimir.su",
    "vologda.su",
    "channelsdvr.net",
    "fastly-terrarium.com",
    "fastlylb.net",
    "map.fastlylb.net",
    "freetls.fastly.net",
    "map.fastly.net",
    "a.prod.fastly.net",
    "global.prod.fastly.net",
    "a.ssl.fastly.net",
    "b.ssl.fastly.net",
    "global.ssl.fastly.net",
    "fastpanel.direct",
    "fastvps-server.com",
    "fhapp.xyz",
    "fedorainfracloud.org",
    "fedorapeople.org",
    "cloud.fedoraproject.org",
    "app.os.fedoraproject.org",
    "app.os.stg.fedoraproject.org",
    "mydobiss.com",
    "filegear.me",
    "filegear-au.me",
    "filegear-de.me",
    "filegear-gb.me",
    "filegear-ie.me",
    "filegear-jp.me",
    "filegear-sg.me",
    "firebaseapp.com",
    "flynnhub.com",
    "flynnhosting.net",
    "freebox-os.com",
    "freeboxos.com",
    "fbx-os.fr",
    "fbxos.fr",
    "freebox-os.fr",
    "freeboxos.fr",
    "freedesktop.org",
    "*.futurecms.at",
    "*.ex.futurecms.at",
    "*.in.futurecms.at",
    "futurehosting.at",
    "futuremailing.at",
    "*.ex.ortsinfo.at",
    "*.kunden.ortsinfo.at",
    "*.statics.cloud",
    "service.gov.uk",
    "gehirn.ne.jp",
    "usercontent.jp",
    "lab.ms",
    "github.io",
    "githubusercontent.com",
    "gitlab.io",
    "glitch.me",
    "lolipop.io",
    "cloudapps.digital",
    "london.cloudapps.digital",
    "homeoffice.gov.uk",
    "ro.im",
    "shop.ro",
    "goip.de",
    "run.app",
    "a.run.app",
    "web.app",
    "*.0emm.com",
    "appspot.com",
    "blogspot.ae",
    "blogspot.al",
    "blogspot.am",
    "blogspot.ba",
    "blogspot.be",
    "blogspot.bg",
    "blogspot.bj",
    "blogspot.ca",
    "blogspot.cf",
    "blogspot.ch",
    "blogspot.cl",
    "blogspot.co.at",
    "blogspot.co.id",
    "blogspot.co.il",
    "blogspot.co.ke",
    "blogspot.co.nz",
    "blogspot.co.uk",
    "blogspot.co.za",
    "blogspot.com",
    "blogspot.com.ar",
    "blogspot.com.au",
    "blogspot.com.br",
    "blogspot.com.by",
    "blogspot.com.co",
    "blogspot.com.cy",
    "blogspot.com.ee",
    "blogspot.com.eg",
    "blogspot.com.es",
    "blogspot.com.mt",
    "blogspot.com.ng",
    "blogspot.com.tr",
    "blogspot.com.uy",
    "blogspot.cv",
    "blogspot.cz",
    "blogspot.de",
    "blogspot.dk",
    "blogspot.fi",
    "blogspot.fr",
    "blogspot.gr",
    "blogspot.hk",
    "blogspot.hr",
    "blogspot.hu",
    "blogspot.ie",
    "blogspot.in",
    "blogspot.is",
    "blogspot.it",
    "blogspot.jp",
    "blogspot.kr",
    "blogspot.li",
    "blogspot.lt",
    "blogspot.lu",
    "blogspot.md",
    "blogspot.mk",
    "blogspot.mr",
    "blogspot.mx",
    "blogspot.my",
    "blogspot.nl",
    "blogspot.no",
    "blogspot.pe",
    "blogspot.pt",
    "blogspot.qa",
    "blogspot.re",
    "blogspot.ro",
    "blogspot.rs",
    "blogspot.ru",
    "blogspot.se",
    "blogspot.sg",
    "blogspot.si",
    "blogspot.sk",
    "blogspot.sn",
    "blogspot.td",
    "blogspot.tw",
    "blogspot.ug",
    "blogspot.vn",
    "cloudfunctions.net",
    "cloud.goog",
    "codespot.com",
    "googleapis.com",
    "googlecode.com",
    "pagespeedmobilizer.com",
    "publishproxy.com",
    "withgoogle.com",
    "withyoutube.com",
    "fin.ci",
    "free.hr",
    "caa.li",
    "ua.rs",
    "conf.se",
    "hs.zone",
    "hs.run",
    "hashbang.sh",
    "hasura.app",
    "hasura-app.io",
    "hepforge.org",
    "herokuapp.com",
    "herokussl.com",
    "myravendb.com",
    "ravendb.community",
    "ravendb.me",
    "development.run",
    "ravendb.run",
    "bpl.biz",
    "orx.biz",
    "ng.city",
    "biz.gl",
    "ng.ink",
    "col.ng",
    "firm.ng",
    "gen.ng",
    "ltd.ng",
    "ng.school",
    "sch.so",
    "häkkinen.fi",
    "*.moonscale.io",
    "moonscale.net",
    "iki.fi",
    "dyn-berlin.de",
    "in-berlin.de",
    "in-brb.de",
    "in-butter.de",
    "in-dsl.de",
    "in-dsl.net",
    "in-dsl.org",
    "in-vpn.de",
    "in-vpn.net",
    "in-vpn.org",
    "biz.at",
    "info.at",
    "info.cx",
    "ac.leg.br",
    "al.leg.br",
    "am.leg.br",
    "ap.leg.br",
    "ba.leg.br",
    "ce.leg.br",
    "df.leg.br",
    "es.leg.br",
    "go.leg.br",
    "ma.leg.br",
    "mg.leg.br",
    "ms.leg.br",
    "mt.leg.br",
    "pa.leg.br",
    "pb.leg.br",
    "pe.leg.br",
    "pi.leg.br",
    "pr.leg.br",
    "rj.leg.br",
    "rn.leg.br",
    "ro.leg.br",
    "rr.leg.br",
    "rs.leg.br",
    "sc.leg.br",
    "se.leg.br",
    "sp.leg.br",
    "to.leg.br",
    "pixolino.com",
    "ipifony.net",
    "mein-iserv.de",
    "test-iserv.de",
    "iserv.dev",
    "iobb.net",
    "myjino.ru",
    "*.hosting.myjino.ru",
    "*.landing.myjino.ru",
    "*.spectrum.myjino.ru",
    "*.vps.myjino.ru",
    "*.triton.zone",
    "*.cns.joyent.com",
    "js.org",
    "kaas.gg",
    "khplay.nl",
    "keymachine.de",
    "kinghost.net",
    "uni5.net",
    "knightpoint.systems",
    "co.krd",
    "edu.krd",
    "git-repos.de",
    "lcube-server.de",
    "svn-repos.de",
    "leadpages.co",
    "lpages.co",
    "lpusercontent.com",
    "lelux.site",
    "co.business",
    "co.education",
    "co.events",
    "co.financial",
    "co.network",
    "co.place",
    "co.technology",
    "app.lmpm.com",
    "linkitools.space",
    "linkyard.cloud",
    "linkyard-cloud.ch",
    "members.linode.com",
    "nodebalancer.linode.com",
    "we.bs",
    "loginline.app",
    "loginline.dev",
    "loginline.io",
    "loginline.services",
    "loginline.site",
    "krasnik.pl",
    "leczna.pl",
    "lubartow.pl",
    "lublin.pl",
    "poniatowa.pl",
    "swidnik.pl",
    "uklugs.org",
    "glug.org.uk",
    "lug.org.uk",
    "lugs.org.uk",
    "barsy.bg",
    "barsy.co.uk",
    "barsyonline.co.uk",
    "barsycenter.com",
    "barsyonline.com",
    "barsy.club",
    "barsy.de",
    "barsy.eu",
    "barsy.in",
    "barsy.info",
    "barsy.io",
    "barsy.me",
    "barsy.menu",
    "barsy.mobi",
    "barsy.net",
    "barsy.online",
    "barsy.org",
    "barsy.pro",
    "barsy.pub",
    "barsy.shop",
    "barsy.site",
    "barsy.support",
    "barsy.uk",
    "*.magentosite.cloud",
    "mayfirst.info",
    "mayfirst.org",
    "hb.cldmail.ru",
    "miniserver.com",
    "memset.net",
    "cloud.metacentrum.cz",
    "custom.metacentrum.cz",
    "flt.cloud.muni.cz",
    "usr.cloud.muni.cz",
    "meteorapp.com",
    "eu.meteorapp.com",
    "co.pl",
    "azurecontainer.io",
    "azurewebsites.net",
    "azure-mobile.net",
    "cloudapp.net",
    "mozilla-iot.org",
    "bmoattachments.org",
    "net.ru",
    "org.ru",
    "pp.ru",
    "ui.nabu.casa",
    "pony.club",
    "of.fashion",
    "on.fashion",
    "of.football",
    "in.london",
    "of.london",
    "for.men",
    "and.mom",
    "for.mom",
    "for.one",
    "for.sale",
    "of.work",
    "to.work",
    "nctu.me",
    "bitballoon.com",
    "netlify.com",
    "4u.com",
    "ngrok.io",
    "nh-serv.co.uk",
    "nfshost.com",
    "dnsking.ch",
    "mypi.co",
    "n4t.co",
    "001www.com",
    "ddnslive.com",
    "myiphost.com",
    "forumz.info",
    "16-b.it",
    "32-b.it",
    "64-b.it",
    "soundcast.me",
    "tcp4.me",
    "dnsup.net",
    "hicam.net",
    "now-dns.net",
    "ownip.net",
    "vpndns.net",
    "dynserv.org",
    "now-dns.org",
    "x443.pw",
    "now-dns.top",
    "ntdll.top",
    "freeddns.us",
    "crafting.xyz",
    "zapto.xyz",
    "nsupdate.info",
    "nerdpol.ovh",
    "blogsyte.com",
    "brasilia.me",
    "cable-modem.org",
    "ciscofreak.com",
    "collegefan.org",
    "couchpotatofries.org",
    "damnserver.com",
    "ddns.me",
    "ditchyourip.com",
    "dnsfor.me",
    "dnsiskinky.com",
    "dvrcam.info",
    "dynns.com",
    "eating-organic.net",
    "fantasyleague.cc",
    "geekgalaxy.com",
    "golffan.us",
    "health-carereform.com",
    "homesecuritymac.com",
    "homesecuritypc.com",
    "hopto.me",
    "ilovecollege.info",
    "loginto.me",
    "mlbfan.org",
    "mmafan.biz",
    "myactivedirectory.com",
    "mydissent.net",
    "myeffect.net",
    "mymediapc.net",
    "mypsx.net",
    "mysecuritycamera.com",
    "mysecuritycamera.net",
    "mysecuritycamera.org",
    "net-freaks.com",
    "nflfan.org",
    "nhlfan.net",
    "no-ip.ca",
    "no-ip.co.uk",
    "no-ip.net",
    "noip.us",
    "onthewifi.com",
    "pgafan.net",
    "point2this.com",
    "pointto.us",
    "privatizehealthinsurance.net",
    "quicksytes.com",
    "read-books.org",
    "securitytactics.com",
    "serveexchange.com",
    "servehumour.com",
    "servep2p.com",
    "servesarcasm.com",
    "stufftoread.com",
    "ufcfan.org",
    "unusualperson.com",
    "workisboring.com",
    "3utilities.com",
    "bounceme.net",
    "ddns.net",
    "ddnsking.com",
    "gotdns.ch",
    "hopto.org",
    "myftp.biz",
    "myftp.org",
    "myvnc.com",
    "no-ip.biz",
    "no-ip.info",
    "no-ip.org",
    "noip.me",
    "redirectme.net",
    "servebeer.com",
    "serveblog.net",
    "servecounterstrike.com",
    "serveftp.com",
    "servegame.com",
    "servehalflife.com",
    "servehttp.com",
    "serveirc.com",
    "serveminecraft.net",
    "servemp3.com",
    "servepics.com",
    "servequake.com",
    "sytes.net",
    "webhop.me",
    "zapto.org",
    "stage.nodeart.io",
    "nodum.co",
    "nodum.io",
    "pcloud.host",
    "nyc.mn",
    "nom.ae",
    "nom.af",
    "nom.ai",
    "nom.al",
    "nym.by",
    "nym.bz",
    "nom.cl",
    "nym.ec",
    "nom.gd",
    "nom.ge",
    "nom.gl",
    "nym.gr",
    "nom.gt",
    "nym.gy",
    "nym.hk",
    "nom.hn",
    "nym.ie",
    "nom.im",
    "nom.ke",
    "nym.kz",
    "nym.la",
    "nym.lc",
    "nom.li",
    "nym.li",
    "nym.lt",
    "nym.lu",
    "nym.me",
    "nom.mk",
    "nym.mn",
    "nym.mx",
    "nom.nu",
    "nym.nz",
    "nym.pe",
    "nym.pt",
    "nom.pw",
    "nom.qa",
    "nym.ro",
    "nom.rs",
    "nom.si",
    "nym.sk",
    "nom.st",
    "nym.su",
    "nym.sx",
    "nom.tj",
    "nym.tw",
    "nom.ug",
    "nom.uy",
    "nom.vc",
    "nom.vg",
    "cya.gg",
    "cloudycluster.net",
    "nid.io",
    "opencraft.hosting",
    "operaunite.com",
    "outsystemscloud.com",
    "ownprovider.com",
    "own.pm",
    "ox.rs",
    "oy.lc",
    "pgfog.com",
    "pagefrontapp.com",
    "art.pl",
    "gliwice.pl",
    "krakow.pl",
    "poznan.pl",
    "wroc.pl",
    "zakopane.pl",
    "pantheonsite.io",
    "gotpantheon.com",
    "mypep.link",
    "on-web.fr",
    "*.platform.sh",
    "*.platformsh.site",
    "dyn53.io",
    "co.bn",
    "xen.prgmr.com",
    "priv.at",
    "prvcy.page",
    "*.dweb.link",
    "protonet.io",
    "chirurgiens-dentistes-en-france.fr",
    "byen.site",
    "pubtls.org",
    "qualifioapp.com",
    "instantcloud.cn",
    "ras.ru",
    "qa2.com",
    "dev-myqnapcloud.com",
    "alpha-myqnapcloud.com",
    "myqnapcloud.com",
    "*.quipelements.com",
    "vapor.cloud",
    "vaporcloud.io",
    "rackmaze.com",
    "rackmaze.net",
    "*.on-rancher.cloud",
    "*.on-rio.io",
    "readthedocs.io",
    "rhcloud.com",
    "app.render.com",
    "onrender.com",
    "repl.co",
    "repl.run",
    "resindevice.io",
    "devices.resinstaging.io",
    "hzc.io",
    "wellbeingzone.eu",
    "ptplus.fit",
    "wellbeingzone.co.uk",
    "git-pages.rit.edu",
    "sandcats.io",
    "logoip.de",
    "logoip.com",
    "schokokeks.net",
    "scrysec.com",
    "firewall-gateway.com",
    "firewall-gateway.de",
    "my-gateway.de",
    "my-router.de",
    "spdns.de",
    "spdns.eu",
    "firewall-gateway.net",
    "my-firewall.org",
    "myfirewall.org",
    "spdns.org",
    "biz.ua",
    "co.ua",
    "pp.ua",
    "shiftedit.io",
    "myshopblocks.com",
    "shopitsite.com",
    "mo-siemens.io",
    "1kapp.com",
    "appchizi.com",
    "applinzi.com",
    "sinaapp.com",
    "vipsinaapp.com",
    "siteleaf.net",
    "bounty-full.com",
    "alpha.bounty-full.com",
    "beta.bounty-full.com",
    "stackhero-network.com",
    "static.land",
    "dev.static.land",
    "sites.static.land",
    "apps.lair.io",
    "*.stolos.io",
    "spacekit.io",
    "customer.speedpartner.de",
    "api.stdlib.com",
    "storj.farm",
    "utwente.io",
    "soc.srcf.net",
    "user.srcf.net",
    "temp-dns.com",
    "applicationcloud.io",
    "scapp.io",
    "*.s5y.io",
    "*.sensiosite.cloud",
    "syncloud.it",
    "diskstation.me",
    "dscloud.biz",
    "dscloud.me",
    "dscloud.mobi",
    "dsmynas.com",
    "dsmynas.net",
    "dsmynas.org",
    "familyds.com",
    "familyds.net",
    "familyds.org",
    "i234.me",
    "myds.me",
    "synology.me",
    "vpnplus.to",
    "direct.quickconnect.to",
    "taifun-dns.de",
    "gda.pl",
    "gdansk.pl",
    "gdynia.pl",
    "med.pl",
    "sopot.pl",
    "edugit.org",
    "telebit.app",
    "telebit.io",
    "*.telebit.xyz",
    "gwiddle.co.uk",
    "thingdustdata.com",
    "cust.dev.thingdust.io",
    "cust.disrec.thingdust.io",
    "cust.prod.thingdust.io",
    "cust.testing.thingdust.io",
    "arvo.network",
    "azimuth.network",
    "bloxcms.com",
    "townnews-staging.com",
    "12hp.at",
    "2ix.at",
    "4lima.at",
    "lima-city.at",
    "12hp.ch",
    "2ix.ch",
    "4lima.ch",
    "lima-city.ch",
    "trafficplex.cloud",
    "de.cool",
    "12hp.de",
    "2ix.de",
    "4lima.de",
    "lima-city.de",
    "1337.pictures",
    "clan.rip",
    "lima-city.rocks",
    "webspace.rocks",
    "lima.zone",
    "*.transurl.be",
    "*.transurl.eu",
    "*.transurl.nl",
    "tuxfamily.org",
    "dd-dns.de",
    "diskstation.eu",
    "diskstation.org",
    "dray-dns.de",
    "draydns.de",
    "dyn-vpn.de",
    "dynvpn.de",
    "mein-vigor.de",
    "my-vigor.de",
    "my-wan.de",
    "syno-ds.de",
    "synology-diskstation.de",
    "synology-ds.de",
    "uber.space",
    "*.uberspace.de",
    "hk.com",
    "hk.org",
    "ltd.hk",
    "inc.hk",
    "virtualuser.de",
    "virtual-user.de",
    "lib.de.us",
    "2038.io",
    "router.management",
    "v-info.info",
    "voorloper.cloud",
    "wafflecell.com",
    "*.webhare.dev",
    "wedeploy.io",
    "wedeploy.me",
    "wedeploy.sh",
    "remotewd.com",
    "wmflabs.org",
    "half.host",
    "xnbay.com",
    "u2.xnbay.com",
    "u2-local.xnbay.com",
    "cistron.nl",
    "demon.nl",
    "xs4all.space",
    "yandexcloud.net",
    "storage.yandexcloud.net",
    "website.yandexcloud.net",
    "official.academy",
    "yolasite.com",
    "ybo.faith",
    "yombo.me",
    "homelink.one",
    "ybo.party",
    "ybo.review",
    "ybo.science",
    "ybo.trade",
    "nohost.me",
    "noho.st",
    "za.net",
    "za.org",
    "now.sh",
    "bss.design",
    "basicserver.io",
    "virtualserver.io",
    "site.builder.nu",
    "enterprisecloud.nu"
];

module.exports = {
    tldList
};

},{}],4:[function(require,module,exports){
'use strict'

exports.byteLength = byteLength
exports.toByteArray = toByteArray
exports.fromByteArray = fromByteArray

var lookup = []
var revLookup = []
var Arr = typeof Uint8Array !== 'undefined' ? Uint8Array : Array

var code = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
for (var i = 0, len = code.length; i < len; ++i) {
  lookup[i] = code[i]
  revLookup[code.charCodeAt(i)] = i
}

// Support decoding URL-safe base64 strings, as Node.js does.
// See: https://en.wikipedia.org/wiki/Base64#URL_applications
revLookup['-'.charCodeAt(0)] = 62
revLookup['_'.charCodeAt(0)] = 63

function getLens (b64) {
  var len = b64.length

  if (len % 4 > 0) {
    throw new Error('Invalid string. Length must be a multiple of 4')
  }

  // Trim off extra bytes after placeholder bytes are found
  // See: https://github.com/beatgammit/base64-js/issues/42
  var validLen = b64.indexOf('=')
  if (validLen === -1) validLen = len

  var placeHoldersLen = validLen === len
    ? 0
    : 4 - (validLen % 4)

  return [validLen, placeHoldersLen]
}

// base64 is 4/3 + up to two characters of the original data
function byteLength (b64) {
  var lens = getLens(b64)
  var validLen = lens[0]
  var placeHoldersLen = lens[1]
  return ((validLen + placeHoldersLen) * 3 / 4) - placeHoldersLen
}

function _byteLength (b64, validLen, placeHoldersLen) {
  return ((validLen + placeHoldersLen) * 3 / 4) - placeHoldersLen
}

function toByteArray (b64) {
  var tmp
  var lens = getLens(b64)
  var validLen = lens[0]
  var placeHoldersLen = lens[1]

  var arr = new Arr(_byteLength(b64, validLen, placeHoldersLen))

  var curByte = 0

  // if there are placeholders, only get up to the last complete 4 chars
  var len = placeHoldersLen > 0
    ? validLen - 4
    : validLen

  for (var i = 0; i < len; i += 4) {
    tmp =
      (revLookup[b64.charCodeAt(i)] << 18) |
      (revLookup[b64.charCodeAt(i + 1)] << 12) |
      (revLookup[b64.charCodeAt(i + 2)] << 6) |
      revLookup[b64.charCodeAt(i + 3)]
    arr[curByte++] = (tmp >> 16) & 0xFF
    arr[curByte++] = (tmp >> 8) & 0xFF
    arr[curByte++] = tmp & 0xFF
  }

  if (placeHoldersLen === 2) {
    tmp =
      (revLookup[b64.charCodeAt(i)] << 2) |
      (revLookup[b64.charCodeAt(i + 1)] >> 4)
    arr[curByte++] = tmp & 0xFF
  }

  if (placeHoldersLen === 1) {
    tmp =
      (revLookup[b64.charCodeAt(i)] << 10) |
      (revLookup[b64.charCodeAt(i + 1)] << 4) |
      (revLookup[b64.charCodeAt(i + 2)] >> 2)
    arr[curByte++] = (tmp >> 8) & 0xFF
    arr[curByte++] = tmp & 0xFF
  }

  return arr
}

function tripletToBase64 (num) {
  return lookup[num >> 18 & 0x3F] +
    lookup[num >> 12 & 0x3F] +
    lookup[num >> 6 & 0x3F] +
    lookup[num & 0x3F]
}

function encodeChunk (uint8, start, end) {
  var tmp
  var output = []
  for (var i = start; i < end; i += 3) {
    tmp =
      ((uint8[i] << 16) & 0xFF0000) +
      ((uint8[i + 1] << 8) & 0xFF00) +
      (uint8[i + 2] & 0xFF)
    output.push(tripletToBase64(tmp))
  }
  return output.join('')
}

function fromByteArray (uint8) {
  var tmp
  var len = uint8.length
  var extraBytes = len % 3 // if we have 1 byte left, pad 2 bytes
  var parts = []
  var maxChunkLength = 16383 // must be multiple of 3

  // go through the array every three bytes, we'll deal with trailing stuff later
  for (var i = 0, len2 = len - extraBytes; i < len2; i += maxChunkLength) {
    parts.push(encodeChunk(
      uint8, i, (i + maxChunkLength) > len2 ? len2 : (i + maxChunkLength)
    ))
  }

  // pad the end with zeros, but make sure to not forget the extra bytes
  if (extraBytes === 1) {
    tmp = uint8[len - 1]
    parts.push(
      lookup[tmp >> 2] +
      lookup[(tmp << 4) & 0x3F] +
      '=='
    )
  } else if (extraBytes === 2) {
    tmp = (uint8[len - 2] << 8) + uint8[len - 1]
    parts.push(
      lookup[tmp >> 10] +
      lookup[(tmp >> 4) & 0x3F] +
      lookup[(tmp << 2) & 0x3F] +
      '='
    )
  }

  return parts.join('')
}

},{}],5:[function(require,module,exports){
/*!
 * The buffer module from node.js, for the browser.
 *
 * @author   Feross Aboukhadijeh <https://feross.org>
 * @license  MIT
 */
/* eslint-disable no-proto */

'use strict'

var base64 = require('base64-js')
var ieee754 = require('ieee754')

exports.Buffer = Buffer
exports.SlowBuffer = SlowBuffer
exports.INSPECT_MAX_BYTES = 50

var K_MAX_LENGTH = 0x7fffffff
exports.kMaxLength = K_MAX_LENGTH

/**
 * If `Buffer.TYPED_ARRAY_SUPPORT`:
 *   === true    Use Uint8Array implementation (fastest)
 *   === false   Print warning and recommend using `buffer` v4.x which has an Object
 *               implementation (most compatible, even IE6)
 *
 * Browsers that support typed arrays are IE 10+, Firefox 4+, Chrome 7+, Safari 5.1+,
 * Opera 11.6+, iOS 4.2+.
 *
 * We report that the browser does not support typed arrays if the are not subclassable
 * using __proto__. Firefox 4-29 lacks support for adding new properties to `Uint8Array`
 * (See: https://bugzilla.mozilla.org/show_bug.cgi?id=695438). IE 10 lacks support
 * for __proto__ and has a buggy typed array implementation.
 */
Buffer.TYPED_ARRAY_SUPPORT = typedArraySupport()

if (!Buffer.TYPED_ARRAY_SUPPORT && typeof console !== 'undefined' &&
    typeof console.error === 'function') {
  console.error(
    'This browser lacks typed array (Uint8Array) support which is required by ' +
    '`buffer` v5.x. Use `buffer` v4.x if you require old browser support.'
  )
}

function typedArraySupport () {
  // Can typed array instances can be augmented?
  try {
    var arr = new Uint8Array(1)
    arr.__proto__ = { __proto__: Uint8Array.prototype, foo: function () { return 42 } }
    return arr.foo() === 42
  } catch (e) {
    return false
  }
}

Object.defineProperty(Buffer.prototype, 'parent', {
  enumerable: true,
  get: function () {
    if (!Buffer.isBuffer(this)) return undefined
    return this.buffer
  }
})

Object.defineProperty(Buffer.prototype, 'offset', {
  enumerable: true,
  get: function () {
    if (!Buffer.isBuffer(this)) return undefined
    return this.byteOffset
  }
})

function createBuffer (length) {
  if (length > K_MAX_LENGTH) {
    throw new RangeError('The value "' + length + '" is invalid for option "size"')
  }
  // Return an augmented `Uint8Array` instance
  var buf = new Uint8Array(length)
  buf.__proto__ = Buffer.prototype
  return buf
}

/**
 * The Buffer constructor returns instances of `Uint8Array` that have their
 * prototype changed to `Buffer.prototype`. Furthermore, `Buffer` is a subclass of
 * `Uint8Array`, so the returned instances will have all the node `Buffer` methods
 * and the `Uint8Array` methods. Square bracket notation works as expected -- it
 * returns a single octet.
 *
 * The `Uint8Array` prototype remains unmodified.
 */

function Buffer (arg, encodingOrOffset, length) {
  // Common case.
  if (typeof arg === 'number') {
    if (typeof encodingOrOffset === 'string') {
      throw new TypeError(
        'The "string" argument must be of type string. Received type number'
      )
    }
    return allocUnsafe(arg)
  }
  return from(arg, encodingOrOffset, length)
}

// Fix subarray() in ES2016. See: https://github.com/feross/buffer/pull/97
if (typeof Symbol !== 'undefined' && Symbol.species != null &&
    Buffer[Symbol.species] === Buffer) {
  Object.defineProperty(Buffer, Symbol.species, {
    value: null,
    configurable: true,
    enumerable: false,
    writable: false
  })
}

Buffer.poolSize = 8192 // not used by this implementation

function from (value, encodingOrOffset, length) {
  if (typeof value === 'string') {
    return fromString(value, encodingOrOffset)
  }

  if (ArrayBuffer.isView(value)) {
    return fromArrayLike(value)
  }

  if (value == null) {
    throw TypeError(
      'The first argument must be one of type string, Buffer, ArrayBuffer, Array, ' +
      'or Array-like Object. Received type ' + (typeof value)
    )
  }

  if (isInstance(value, ArrayBuffer) ||
      (value && isInstance(value.buffer, ArrayBuffer))) {
    return fromArrayBuffer(value, encodingOrOffset, length)
  }

  if (typeof value === 'number') {
    throw new TypeError(
      'The "value" argument must not be of type number. Received type number'
    )
  }

  var valueOf = value.valueOf && value.valueOf()
  if (valueOf != null && valueOf !== value) {
    return Buffer.from(valueOf, encodingOrOffset, length)
  }

  var b = fromObject(value)
  if (b) return b

  if (typeof Symbol !== 'undefined' && Symbol.toPrimitive != null &&
      typeof value[Symbol.toPrimitive] === 'function') {
    return Buffer.from(
      value[Symbol.toPrimitive]('string'), encodingOrOffset, length
    )
  }

  throw new TypeError(
    'The first argument must be one of type string, Buffer, ArrayBuffer, Array, ' +
    'or Array-like Object. Received type ' + (typeof value)
  )
}

/**
 * Functionally equivalent to Buffer(arg, encoding) but throws a TypeError
 * if value is a number.
 * Buffer.from(str[, encoding])
 * Buffer.from(array)
 * Buffer.from(buffer)
 * Buffer.from(arrayBuffer[, byteOffset[, length]])
 **/
Buffer.from = function (value, encodingOrOffset, length) {
  return from(value, encodingOrOffset, length)
}

// Note: Change prototype *after* Buffer.from is defined to workaround Chrome bug:
// https://github.com/feross/buffer/pull/148
Buffer.prototype.__proto__ = Uint8Array.prototype
Buffer.__proto__ = Uint8Array

function assertSize (size) {
  if (typeof size !== 'number') {
    throw new TypeError('"size" argument must be of type number')
  } else if (size < 0) {
    throw new RangeError('The value "' + size + '" is invalid for option "size"')
  }
}

function alloc (size, fill, encoding) {
  assertSize(size)
  if (size <= 0) {
    return createBuffer(size)
  }
  if (fill !== undefined) {
    // Only pay attention to encoding if it's a string. This
    // prevents accidentally sending in a number that would
    // be interpretted as a start offset.
    return typeof encoding === 'string'
      ? createBuffer(size).fill(fill, encoding)
      : createBuffer(size).fill(fill)
  }
  return createBuffer(size)
}

/**
 * Creates a new filled Buffer instance.
 * alloc(size[, fill[, encoding]])
 **/
Buffer.alloc = function (size, fill, encoding) {
  return alloc(size, fill, encoding)
}

function allocUnsafe (size) {
  assertSize(size)
  return createBuffer(size < 0 ? 0 : checked(size) | 0)
}

/**
 * Equivalent to Buffer(num), by default creates a non-zero-filled Buffer instance.
 * */
Buffer.allocUnsafe = function (size) {
  return allocUnsafe(size)
}
/**
 * Equivalent to SlowBuffer(num), by default creates a non-zero-filled Buffer instance.
 */
Buffer.allocUnsafeSlow = function (size) {
  return allocUnsafe(size)
}

function fromString (string, encoding) {
  if (typeof encoding !== 'string' || encoding === '') {
    encoding = 'utf8'
  }

  if (!Buffer.isEncoding(encoding)) {
    throw new TypeError('Unknown encoding: ' + encoding)
  }

  var length = byteLength(string, encoding) | 0
  var buf = createBuffer(length)

  var actual = buf.write(string, encoding)

  if (actual !== length) {
    // Writing a hex string, for example, that contains invalid characters will
    // cause everything after the first invalid character to be ignored. (e.g.
    // 'abxxcd' will be treated as 'ab')
    buf = buf.slice(0, actual)
  }

  return buf
}

function fromArrayLike (array) {
  var length = array.length < 0 ? 0 : checked(array.length) | 0
  var buf = createBuffer(length)
  for (var i = 0; i < length; i += 1) {
    buf[i] = array[i] & 255
  }
  return buf
}

function fromArrayBuffer (array, byteOffset, length) {
  if (byteOffset < 0 || array.byteLength < byteOffset) {
    throw new RangeError('"offset" is outside of buffer bounds')
  }

  if (array.byteLength < byteOffset + (length || 0)) {
    throw new RangeError('"length" is outside of buffer bounds')
  }

  var buf
  if (byteOffset === undefined && length === undefined) {
    buf = new Uint8Array(array)
  } else if (length === undefined) {
    buf = new Uint8Array(array, byteOffset)
  } else {
    buf = new Uint8Array(array, byteOffset, length)
  }

  // Return an augmented `Uint8Array` instance
  buf.__proto__ = Buffer.prototype
  return buf
}

function fromObject (obj) {
  if (Buffer.isBuffer(obj)) {
    var len = checked(obj.length) | 0
    var buf = createBuffer(len)

    if (buf.length === 0) {
      return buf
    }

    obj.copy(buf, 0, 0, len)
    return buf
  }

  if (obj.length !== undefined) {
    if (typeof obj.length !== 'number' || numberIsNaN(obj.length)) {
      return createBuffer(0)
    }
    return fromArrayLike(obj)
  }

  if (obj.type === 'Buffer' && Array.isArray(obj.data)) {
    return fromArrayLike(obj.data)
  }
}

function checked (length) {
  // Note: cannot use `length < K_MAX_LENGTH` here because that fails when
  // length is NaN (which is otherwise coerced to zero.)
  if (length >= K_MAX_LENGTH) {
    throw new RangeError('Attempt to allocate Buffer larger than maximum ' +
                         'size: 0x' + K_MAX_LENGTH.toString(16) + ' bytes')
  }
  return length | 0
}

function SlowBuffer (length) {
  if (+length != length) { // eslint-disable-line eqeqeq
    length = 0
  }
  return Buffer.alloc(+length)
}

Buffer.isBuffer = function isBuffer (b) {
  return b != null && b._isBuffer === true &&
    b !== Buffer.prototype // so Buffer.isBuffer(Buffer.prototype) will be false
}

Buffer.compare = function compare (a, b) {
  if (isInstance(a, Uint8Array)) a = Buffer.from(a, a.offset, a.byteLength)
  if (isInstance(b, Uint8Array)) b = Buffer.from(b, b.offset, b.byteLength)
  if (!Buffer.isBuffer(a) || !Buffer.isBuffer(b)) {
    throw new TypeError(
      'The "buf1", "buf2" arguments must be one of type Buffer or Uint8Array'
    )
  }

  if (a === b) return 0

  var x = a.length
  var y = b.length

  for (var i = 0, len = Math.min(x, y); i < len; ++i) {
    if (a[i] !== b[i]) {
      x = a[i]
      y = b[i]
      break
    }
  }

  if (x < y) return -1
  if (y < x) return 1
  return 0
}

Buffer.isEncoding = function isEncoding (encoding) {
  switch (String(encoding).toLowerCase()) {
    case 'hex':
    case 'utf8':
    case 'utf-8':
    case 'ascii':
    case 'latin1':
    case 'binary':
    case 'base64':
    case 'ucs2':
    case 'ucs-2':
    case 'utf16le':
    case 'utf-16le':
      return true
    default:
      return false
  }
}

Buffer.concat = function concat (list, length) {
  if (!Array.isArray(list)) {
    throw new TypeError('"list" argument must be an Array of Buffers')
  }

  if (list.length === 0) {
    return Buffer.alloc(0)
  }

  var i
  if (length === undefined) {
    length = 0
    for (i = 0; i < list.length; ++i) {
      length += list[i].length
    }
  }

  var buffer = Buffer.allocUnsafe(length)
  var pos = 0
  for (i = 0; i < list.length; ++i) {
    var buf = list[i]
    if (isInstance(buf, Uint8Array)) {
      buf = Buffer.from(buf)
    }
    if (!Buffer.isBuffer(buf)) {
      throw new TypeError('"list" argument must be an Array of Buffers')
    }
    buf.copy(buffer, pos)
    pos += buf.length
  }
  return buffer
}

function byteLength (string, encoding) {
  if (Buffer.isBuffer(string)) {
    return string.length
  }
  if (ArrayBuffer.isView(string) || isInstance(string, ArrayBuffer)) {
    return string.byteLength
  }
  if (typeof string !== 'string') {
    throw new TypeError(
      'The "string" argument must be one of type string, Buffer, or ArrayBuffer. ' +
      'Received type ' + typeof string
    )
  }

  var len = string.length
  var mustMatch = (arguments.length > 2 && arguments[2] === true)
  if (!mustMatch && len === 0) return 0

  // Use a for loop to avoid recursion
  var loweredCase = false
  for (;;) {
    switch (encoding) {
      case 'ascii':
      case 'latin1':
      case 'binary':
        return len
      case 'utf8':
      case 'utf-8':
        return utf8ToBytes(string).length
      case 'ucs2':
      case 'ucs-2':
      case 'utf16le':
      case 'utf-16le':
        return len * 2
      case 'hex':
        return len >>> 1
      case 'base64':
        return base64ToBytes(string).length
      default:
        if (loweredCase) {
          return mustMatch ? -1 : utf8ToBytes(string).length // assume utf8
        }
        encoding = ('' + encoding).toLowerCase()
        loweredCase = true
    }
  }
}
Buffer.byteLength = byteLength

function slowToString (encoding, start, end) {
  var loweredCase = false

  // No need to verify that "this.length <= MAX_UINT32" since it's a read-only
  // property of a typed array.

  // This behaves neither like String nor Uint8Array in that we set start/end
  // to their upper/lower bounds if the value passed is out of range.
  // undefined is handled specially as per ECMA-262 6th Edition,
  // Section 13.3.3.7 Runtime Semantics: KeyedBindingInitialization.
  if (start === undefined || start < 0) {
    start = 0
  }
  // Return early if start > this.length. Done here to prevent potential uint32
  // coercion fail below.
  if (start > this.length) {
    return ''
  }

  if (end === undefined || end > this.length) {
    end = this.length
  }

  if (end <= 0) {
    return ''
  }

  // Force coersion to uint32. This will also coerce falsey/NaN values to 0.
  end >>>= 0
  start >>>= 0

  if (end <= start) {
    return ''
  }

  if (!encoding) encoding = 'utf8'

  while (true) {
    switch (encoding) {
      case 'hex':
        return hexSlice(this, start, end)

      case 'utf8':
      case 'utf-8':
        return utf8Slice(this, start, end)

      case 'ascii':
        return asciiSlice(this, start, end)

      case 'latin1':
      case 'binary':
        return latin1Slice(this, start, end)

      case 'base64':
        return base64Slice(this, start, end)

      case 'ucs2':
      case 'ucs-2':
      case 'utf16le':
      case 'utf-16le':
        return utf16leSlice(this, start, end)

      default:
        if (loweredCase) throw new TypeError('Unknown encoding: ' + encoding)
        encoding = (encoding + '').toLowerCase()
        loweredCase = true
    }
  }
}

// This property is used by `Buffer.isBuffer` (and the `is-buffer` npm package)
// to detect a Buffer instance. It's not possible to use `instanceof Buffer`
// reliably in a browserify context because there could be multiple different
// copies of the 'buffer' package in use. This method works even for Buffer
// instances that were created from another copy of the `buffer` package.
// See: https://github.com/feross/buffer/issues/154
Buffer.prototype._isBuffer = true

function swap (b, n, m) {
  var i = b[n]
  b[n] = b[m]
  b[m] = i
}

Buffer.prototype.swap16 = function swap16 () {
  var len = this.length
  if (len % 2 !== 0) {
    throw new RangeError('Buffer size must be a multiple of 16-bits')
  }
  for (var i = 0; i < len; i += 2) {
    swap(this, i, i + 1)
  }
  return this
}

Buffer.prototype.swap32 = function swap32 () {
  var len = this.length
  if (len % 4 !== 0) {
    throw new RangeError('Buffer size must be a multiple of 32-bits')
  }
  for (var i = 0; i < len; i += 4) {
    swap(this, i, i + 3)
    swap(this, i + 1, i + 2)
  }
  return this
}

Buffer.prototype.swap64 = function swap64 () {
  var len = this.length
  if (len % 8 !== 0) {
    throw new RangeError('Buffer size must be a multiple of 64-bits')
  }
  for (var i = 0; i < len; i += 8) {
    swap(this, i, i + 7)
    swap(this, i + 1, i + 6)
    swap(this, i + 2, i + 5)
    swap(this, i + 3, i + 4)
  }
  return this
}

Buffer.prototype.toString = function toString () {
  var length = this.length
  if (length === 0) return ''
  if (arguments.length === 0) return utf8Slice(this, 0, length)
  return slowToString.apply(this, arguments)
}

Buffer.prototype.toLocaleString = Buffer.prototype.toString

Buffer.prototype.equals = function equals (b) {
  if (!Buffer.isBuffer(b)) throw new TypeError('Argument must be a Buffer')
  if (this === b) return true
  return Buffer.compare(this, b) === 0
}

Buffer.prototype.inspect = function inspect () {
  var str = ''
  var max = exports.INSPECT_MAX_BYTES
  str = this.toString('hex', 0, max).replace(/(.{2})/g, '$1 ').trim()
  if (this.length > max) str += ' ... '
  return '<Buffer ' + str + '>'
}

Buffer.prototype.compare = function compare (target, start, end, thisStart, thisEnd) {
  if (isInstance(target, Uint8Array)) {
    target = Buffer.from(target, target.offset, target.byteLength)
  }
  if (!Buffer.isBuffer(target)) {
    throw new TypeError(
      'The "target" argument must be one of type Buffer or Uint8Array. ' +
      'Received type ' + (typeof target)
    )
  }

  if (start === undefined) {
    start = 0
  }
  if (end === undefined) {
    end = target ? target.length : 0
  }
  if (thisStart === undefined) {
    thisStart = 0
  }
  if (thisEnd === undefined) {
    thisEnd = this.length
  }

  if (start < 0 || end > target.length || thisStart < 0 || thisEnd > this.length) {
    throw new RangeError('out of range index')
  }

  if (thisStart >= thisEnd && start >= end) {
    return 0
  }
  if (thisStart >= thisEnd) {
    return -1
  }
  if (start >= end) {
    return 1
  }

  start >>>= 0
  end >>>= 0
  thisStart >>>= 0
  thisEnd >>>= 0

  if (this === target) return 0

  var x = thisEnd - thisStart
  var y = end - start
  var len = Math.min(x, y)

  var thisCopy = this.slice(thisStart, thisEnd)
  var targetCopy = target.slice(start, end)

  for (var i = 0; i < len; ++i) {
    if (thisCopy[i] !== targetCopy[i]) {
      x = thisCopy[i]
      y = targetCopy[i]
      break
    }
  }

  if (x < y) return -1
  if (y < x) return 1
  return 0
}

// Finds either the first index of `val` in `buffer` at offset >= `byteOffset`,
// OR the last index of `val` in `buffer` at offset <= `byteOffset`.
//
// Arguments:
// - buffer - a Buffer to search
// - val - a string, Buffer, or number
// - byteOffset - an index into `buffer`; will be clamped to an int32
// - encoding - an optional encoding, relevant is val is a string
// - dir - true for indexOf, false for lastIndexOf
function bidirectionalIndexOf (buffer, val, byteOffset, encoding, dir) {
  // Empty buffer means no match
  if (buffer.length === 0) return -1

  // Normalize byteOffset
  if (typeof byteOffset === 'string') {
    encoding = byteOffset
    byteOffset = 0
  } else if (byteOffset > 0x7fffffff) {
    byteOffset = 0x7fffffff
  } else if (byteOffset < -0x80000000) {
    byteOffset = -0x80000000
  }
  byteOffset = +byteOffset // Coerce to Number.
  if (numberIsNaN(byteOffset)) {
    // byteOffset: it it's undefined, null, NaN, "foo", etc, search whole buffer
    byteOffset = dir ? 0 : (buffer.length - 1)
  }

  // Normalize byteOffset: negative offsets start from the end of the buffer
  if (byteOffset < 0) byteOffset = buffer.length + byteOffset
  if (byteOffset >= buffer.length) {
    if (dir) return -1
    else byteOffset = buffer.length - 1
  } else if (byteOffset < 0) {
    if (dir) byteOffset = 0
    else return -1
  }

  // Normalize val
  if (typeof val === 'string') {
    val = Buffer.from(val, encoding)
  }

  // Finally, search either indexOf (if dir is true) or lastIndexOf
  if (Buffer.isBuffer(val)) {
    // Special case: looking for empty string/buffer always fails
    if (val.length === 0) {
      return -1
    }
    return arrayIndexOf(buffer, val, byteOffset, encoding, dir)
  } else if (typeof val === 'number') {
    val = val & 0xFF // Search for a byte value [0-255]
    if (typeof Uint8Array.prototype.indexOf === 'function') {
      if (dir) {
        return Uint8Array.prototype.indexOf.call(buffer, val, byteOffset)
      } else {
        return Uint8Array.prototype.lastIndexOf.call(buffer, val, byteOffset)
      }
    }
    return arrayIndexOf(buffer, [ val ], byteOffset, encoding, dir)
  }

  throw new TypeError('val must be string, number or Buffer')
}

function arrayIndexOf (arr, val, byteOffset, encoding, dir) {
  var indexSize = 1
  var arrLength = arr.length
  var valLength = val.length

  if (encoding !== undefined) {
    encoding = String(encoding).toLowerCase()
    if (encoding === 'ucs2' || encoding === 'ucs-2' ||
        encoding === 'utf16le' || encoding === 'utf-16le') {
      if (arr.length < 2 || val.length < 2) {
        return -1
      }
      indexSize = 2
      arrLength /= 2
      valLength /= 2
      byteOffset /= 2
    }
  }

  function read (buf, i) {
    if (indexSize === 1) {
      return buf[i]
    } else {
      return buf.readUInt16BE(i * indexSize)
    }
  }

  var i
  if (dir) {
    var foundIndex = -1
    for (i = byteOffset; i < arrLength; i++) {
      if (read(arr, i) === read(val, foundIndex === -1 ? 0 : i - foundIndex)) {
        if (foundIndex === -1) foundIndex = i
        if (i - foundIndex + 1 === valLength) return foundIndex * indexSize
      } else {
        if (foundIndex !== -1) i -= i - foundIndex
        foundIndex = -1
      }
    }
  } else {
    if (byteOffset + valLength > arrLength) byteOffset = arrLength - valLength
    for (i = byteOffset; i >= 0; i--) {
      var found = true
      for (var j = 0; j < valLength; j++) {
        if (read(arr, i + j) !== read(val, j)) {
          found = false
          break
        }
      }
      if (found) return i
    }
  }

  return -1
}

Buffer.prototype.includes = function includes (val, byteOffset, encoding) {
  return this.indexOf(val, byteOffset, encoding) !== -1
}

Buffer.prototype.indexOf = function indexOf (val, byteOffset, encoding) {
  return bidirectionalIndexOf(this, val, byteOffset, encoding, true)
}

Buffer.prototype.lastIndexOf = function lastIndexOf (val, byteOffset, encoding) {
  return bidirectionalIndexOf(this, val, byteOffset, encoding, false)
}

function hexWrite (buf, string, offset, length) {
  offset = Number(offset) || 0
  var remaining = buf.length - offset
  if (!length) {
    length = remaining
  } else {
    length = Number(length)
    if (length > remaining) {
      length = remaining
    }
  }

  var strLen = string.length

  if (length > strLen / 2) {
    length = strLen / 2
  }
  for (var i = 0; i < length; ++i) {
    var parsed = parseInt(string.substr(i * 2, 2), 16)
    if (numberIsNaN(parsed)) return i
    buf[offset + i] = parsed
  }
  return i
}

function utf8Write (buf, string, offset, length) {
  return blitBuffer(utf8ToBytes(string, buf.length - offset), buf, offset, length)
}

function asciiWrite (buf, string, offset, length) {
  return blitBuffer(asciiToBytes(string), buf, offset, length)
}

function latin1Write (buf, string, offset, length) {
  return asciiWrite(buf, string, offset, length)
}

function base64Write (buf, string, offset, length) {
  return blitBuffer(base64ToBytes(string), buf, offset, length)
}

function ucs2Write (buf, string, offset, length) {
  return blitBuffer(utf16leToBytes(string, buf.length - offset), buf, offset, length)
}

Buffer.prototype.write = function write (string, offset, length, encoding) {
  // Buffer#write(string)
  if (offset === undefined) {
    encoding = 'utf8'
    length = this.length
    offset = 0
  // Buffer#write(string, encoding)
  } else if (length === undefined && typeof offset === 'string') {
    encoding = offset
    length = this.length
    offset = 0
  // Buffer#write(string, offset[, length][, encoding])
  } else if (isFinite(offset)) {
    offset = offset >>> 0
    if (isFinite(length)) {
      length = length >>> 0
      if (encoding === undefined) encoding = 'utf8'
    } else {
      encoding = length
      length = undefined
    }
  } else {
    throw new Error(
      'Buffer.write(string, encoding, offset[, length]) is no longer supported'
    )
  }

  var remaining = this.length - offset
  if (length === undefined || length > remaining) length = remaining

  if ((string.length > 0 && (length < 0 || offset < 0)) || offset > this.length) {
    throw new RangeError('Attempt to write outside buffer bounds')
  }

  if (!encoding) encoding = 'utf8'

  var loweredCase = false
  for (;;) {
    switch (encoding) {
      case 'hex':
        return hexWrite(this, string, offset, length)

      case 'utf8':
      case 'utf-8':
        return utf8Write(this, string, offset, length)

      case 'ascii':
        return asciiWrite(this, string, offset, length)

      case 'latin1':
      case 'binary':
        return latin1Write(this, string, offset, length)

      case 'base64':
        // Warning: maxLength not taken into account in base64Write
        return base64Write(this, string, offset, length)

      case 'ucs2':
      case 'ucs-2':
      case 'utf16le':
      case 'utf-16le':
        return ucs2Write(this, string, offset, length)

      default:
        if (loweredCase) throw new TypeError('Unknown encoding: ' + encoding)
        encoding = ('' + encoding).toLowerCase()
        loweredCase = true
    }
  }
}

Buffer.prototype.toJSON = function toJSON () {
  return {
    type: 'Buffer',
    data: Array.prototype.slice.call(this._arr || this, 0)
  }
}

function base64Slice (buf, start, end) {
  if (start === 0 && end === buf.length) {
    return base64.fromByteArray(buf)
  } else {
    return base64.fromByteArray(buf.slice(start, end))
  }
}

function utf8Slice (buf, start, end) {
  end = Math.min(buf.length, end)
  var res = []

  var i = start
  while (i < end) {
    var firstByte = buf[i]
    var codePoint = null
    var bytesPerSequence = (firstByte > 0xEF) ? 4
      : (firstByte > 0xDF) ? 3
        : (firstByte > 0xBF) ? 2
          : 1

    if (i + bytesPerSequence <= end) {
      var secondByte, thirdByte, fourthByte, tempCodePoint

      switch (bytesPerSequence) {
        case 1:
          if (firstByte < 0x80) {
            codePoint = firstByte
          }
          break
        case 2:
          secondByte = buf[i + 1]
          if ((secondByte & 0xC0) === 0x80) {
            tempCodePoint = (firstByte & 0x1F) << 0x6 | (secondByte & 0x3F)
            if (tempCodePoint > 0x7F) {
              codePoint = tempCodePoint
            }
          }
          break
        case 3:
          secondByte = buf[i + 1]
          thirdByte = buf[i + 2]
          if ((secondByte & 0xC0) === 0x80 && (thirdByte & 0xC0) === 0x80) {
            tempCodePoint = (firstByte & 0xF) << 0xC | (secondByte & 0x3F) << 0x6 | (thirdByte & 0x3F)
            if (tempCodePoint > 0x7FF && (tempCodePoint < 0xD800 || tempCodePoint > 0xDFFF)) {
              codePoint = tempCodePoint
            }
          }
          break
        case 4:
          secondByte = buf[i + 1]
          thirdByte = buf[i + 2]
          fourthByte = buf[i + 3]
          if ((secondByte & 0xC0) === 0x80 && (thirdByte & 0xC0) === 0x80 && (fourthByte & 0xC0) === 0x80) {
            tempCodePoint = (firstByte & 0xF) << 0x12 | (secondByte & 0x3F) << 0xC | (thirdByte & 0x3F) << 0x6 | (fourthByte & 0x3F)
            if (tempCodePoint > 0xFFFF && tempCodePoint < 0x110000) {
              codePoint = tempCodePoint
            }
          }
      }
    }

    if (codePoint === null) {
      // we did not generate a valid codePoint so insert a
      // replacement char (U+FFFD) and advance only 1 byte
      codePoint = 0xFFFD
      bytesPerSequence = 1
    } else if (codePoint > 0xFFFF) {
      // encode to utf16 (surrogate pair dance)
      codePoint -= 0x10000
      res.push(codePoint >>> 10 & 0x3FF | 0xD800)
      codePoint = 0xDC00 | codePoint & 0x3FF
    }

    res.push(codePoint)
    i += bytesPerSequence
  }

  return decodeCodePointsArray(res)
}

// Based on http://stackoverflow.com/a/22747272/680742, the browser with
// the lowest limit is Chrome, with 0x10000 args.
// We go 1 magnitude less, for safety
var MAX_ARGUMENTS_LENGTH = 0x1000

function decodeCodePointsArray (codePoints) {
  var len = codePoints.length
  if (len <= MAX_ARGUMENTS_LENGTH) {
    return String.fromCharCode.apply(String, codePoints) // avoid extra slice()
  }

  // Decode in chunks to avoid "call stack size exceeded".
  var res = ''
  var i = 0
  while (i < len) {
    res += String.fromCharCode.apply(
      String,
      codePoints.slice(i, i += MAX_ARGUMENTS_LENGTH)
    )
  }
  return res
}

function asciiSlice (buf, start, end) {
  var ret = ''
  end = Math.min(buf.length, end)

  for (var i = start; i < end; ++i) {
    ret += String.fromCharCode(buf[i] & 0x7F)
  }
  return ret
}

function latin1Slice (buf, start, end) {
  var ret = ''
  end = Math.min(buf.length, end)

  for (var i = start; i < end; ++i) {
    ret += String.fromCharCode(buf[i])
  }
  return ret
}

function hexSlice (buf, start, end) {
  var len = buf.length

  if (!start || start < 0) start = 0
  if (!end || end < 0 || end > len) end = len

  var out = ''
  for (var i = start; i < end; ++i) {
    out += toHex(buf[i])
  }
  return out
}

function utf16leSlice (buf, start, end) {
  var bytes = buf.slice(start, end)
  var res = ''
  for (var i = 0; i < bytes.length; i += 2) {
    res += String.fromCharCode(bytes[i] + (bytes[i + 1] * 256))
  }
  return res
}

Buffer.prototype.slice = function slice (start, end) {
  var len = this.length
  start = ~~start
  end = end === undefined ? len : ~~end

  if (start < 0) {
    start += len
    if (start < 0) start = 0
  } else if (start > len) {
    start = len
  }

  if (end < 0) {
    end += len
    if (end < 0) end = 0
  } else if (end > len) {
    end = len
  }

  if (end < start) end = start

  var newBuf = this.subarray(start, end)
  // Return an augmented `Uint8Array` instance
  newBuf.__proto__ = Buffer.prototype
  return newBuf
}

/*
 * Need to make sure that buffer isn't trying to write out of bounds.
 */
function checkOffset (offset, ext, length) {
  if ((offset % 1) !== 0 || offset < 0) throw new RangeError('offset is not uint')
  if (offset + ext > length) throw new RangeError('Trying to access beyond buffer length')
}

Buffer.prototype.readUIntLE = function readUIntLE (offset, byteLength, noAssert) {
  offset = offset >>> 0
  byteLength = byteLength >>> 0
  if (!noAssert) checkOffset(offset, byteLength, this.length)

  var val = this[offset]
  var mul = 1
  var i = 0
  while (++i < byteLength && (mul *= 0x100)) {
    val += this[offset + i] * mul
  }

  return val
}

Buffer.prototype.readUIntBE = function readUIntBE (offset, byteLength, noAssert) {
  offset = offset >>> 0
  byteLength = byteLength >>> 0
  if (!noAssert) {
    checkOffset(offset, byteLength, this.length)
  }

  var val = this[offset + --byteLength]
  var mul = 1
  while (byteLength > 0 && (mul *= 0x100)) {
    val += this[offset + --byteLength] * mul
  }

  return val
}

Buffer.prototype.readUInt8 = function readUInt8 (offset, noAssert) {
  offset = offset >>> 0
  if (!noAssert) checkOffset(offset, 1, this.length)
  return this[offset]
}

Buffer.prototype.readUInt16LE = function readUInt16LE (offset, noAssert) {
  offset = offset >>> 0
  if (!noAssert) checkOffset(offset, 2, this.length)
  return this[offset] | (this[offset + 1] << 8)
}

Buffer.prototype.readUInt16BE = function readUInt16BE (offset, noAssert) {
  offset = offset >>> 0
  if (!noAssert) checkOffset(offset, 2, this.length)
  return (this[offset] << 8) | this[offset + 1]
}

Buffer.prototype.readUInt32LE = function readUInt32LE (offset, noAssert) {
  offset = offset >>> 0
  if (!noAssert) checkOffset(offset, 4, this.length)

  return ((this[offset]) |
      (this[offset + 1] << 8) |
      (this[offset + 2] << 16)) +
      (this[offset + 3] * 0x1000000)
}

Buffer.prototype.readUInt32BE = function readUInt32BE (offset, noAssert) {
  offset = offset >>> 0
  if (!noAssert) checkOffset(offset, 4, this.length)

  return (this[offset] * 0x1000000) +
    ((this[offset + 1] << 16) |
    (this[offset + 2] << 8) |
    this[offset + 3])
}

Buffer.prototype.readIntLE = function readIntLE (offset, byteLength, noAssert) {
  offset = offset >>> 0
  byteLength = byteLength >>> 0
  if (!noAssert) checkOffset(offset, byteLength, this.length)

  var val = this[offset]
  var mul = 1
  var i = 0
  while (++i < byteLength && (mul *= 0x100)) {
    val += this[offset + i] * mul
  }
  mul *= 0x80

  if (val >= mul) val -= Math.pow(2, 8 * byteLength)

  return val
}

Buffer.prototype.readIntBE = function readIntBE (offset, byteLength, noAssert) {
  offset = offset >>> 0
  byteLength = byteLength >>> 0
  if (!noAssert) checkOffset(offset, byteLength, this.length)

  var i = byteLength
  var mul = 1
  var val = this[offset + --i]
  while (i > 0 && (mul *= 0x100)) {
    val += this[offset + --i] * mul
  }
  mul *= 0x80

  if (val >= mul) val -= Math.pow(2, 8 * byteLength)

  return val
}

Buffer.prototype.readInt8 = function readInt8 (offset, noAssert) {
  offset = offset >>> 0
  if (!noAssert) checkOffset(offset, 1, this.length)
  if (!(this[offset] & 0x80)) return (this[offset])
  return ((0xff - this[offset] + 1) * -1)
}

Buffer.prototype.readInt16LE = function readInt16LE (offset, noAssert) {
  offset = offset >>> 0
  if (!noAssert) checkOffset(offset, 2, this.length)
  var val = this[offset] | (this[offset + 1] << 8)
  return (val & 0x8000) ? val | 0xFFFF0000 : val
}

Buffer.prototype.readInt16BE = function readInt16BE (offset, noAssert) {
  offset = offset >>> 0
  if (!noAssert) checkOffset(offset, 2, this.length)
  var val = this[offset + 1] | (this[offset] << 8)
  return (val & 0x8000) ? val | 0xFFFF0000 : val
}

Buffer.prototype.readInt32LE = function readInt32LE (offset, noAssert) {
  offset = offset >>> 0
  if (!noAssert) checkOffset(offset, 4, this.length)

  return (this[offset]) |
    (this[offset + 1] << 8) |
    (this[offset + 2] << 16) |
    (this[offset + 3] << 24)
}

Buffer.prototype.readInt32BE = function readInt32BE (offset, noAssert) {
  offset = offset >>> 0
  if (!noAssert) checkOffset(offset, 4, this.length)

  return (this[offset] << 24) |
    (this[offset + 1] << 16) |
    (this[offset + 2] << 8) |
    (this[offset + 3])
}

Buffer.prototype.readFloatLE = function readFloatLE (offset, noAssert) {
  offset = offset >>> 0
  if (!noAssert) checkOffset(offset, 4, this.length)
  return ieee754.read(this, offset, true, 23, 4)
}

Buffer.prototype.readFloatBE = function readFloatBE (offset, noAssert) {
  offset = offset >>> 0
  if (!noAssert) checkOffset(offset, 4, this.length)
  return ieee754.read(this, offset, false, 23, 4)
}

Buffer.prototype.readDoubleLE = function readDoubleLE (offset, noAssert) {
  offset = offset >>> 0
  if (!noAssert) checkOffset(offset, 8, this.length)
  return ieee754.read(this, offset, true, 52, 8)
}

Buffer.prototype.readDoubleBE = function readDoubleBE (offset, noAssert) {
  offset = offset >>> 0
  if (!noAssert) checkOffset(offset, 8, this.length)
  return ieee754.read(this, offset, false, 52, 8)
}

function checkInt (buf, value, offset, ext, max, min) {
  if (!Buffer.isBuffer(buf)) throw new TypeError('"buffer" argument must be a Buffer instance')
  if (value > max || value < min) throw new RangeError('"value" argument is out of bounds')
  if (offset + ext > buf.length) throw new RangeError('Index out of range')
}

Buffer.prototype.writeUIntLE = function writeUIntLE (value, offset, byteLength, noAssert) {
  value = +value
  offset = offset >>> 0
  byteLength = byteLength >>> 0
  if (!noAssert) {
    var maxBytes = Math.pow(2, 8 * byteLength) - 1
    checkInt(this, value, offset, byteLength, maxBytes, 0)
  }

  var mul = 1
  var i = 0
  this[offset] = value & 0xFF
  while (++i < byteLength && (mul *= 0x100)) {
    this[offset + i] = (value / mul) & 0xFF
  }

  return offset + byteLength
}

Buffer.prototype.writeUIntBE = function writeUIntBE (value, offset, byteLength, noAssert) {
  value = +value
  offset = offset >>> 0
  byteLength = byteLength >>> 0
  if (!noAssert) {
    var maxBytes = Math.pow(2, 8 * byteLength) - 1
    checkInt(this, value, offset, byteLength, maxBytes, 0)
  }

  var i = byteLength - 1
  var mul = 1
  this[offset + i] = value & 0xFF
  while (--i >= 0 && (mul *= 0x100)) {
    this[offset + i] = (value / mul) & 0xFF
  }

  return offset + byteLength
}

Buffer.prototype.writeUInt8 = function writeUInt8 (value, offset, noAssert) {
  value = +value
  offset = offset >>> 0
  if (!noAssert) checkInt(this, value, offset, 1, 0xff, 0)
  this[offset] = (value & 0xff)
  return offset + 1
}

Buffer.prototype.writeUInt16LE = function writeUInt16LE (value, offset, noAssert) {
  value = +value
  offset = offset >>> 0
  if (!noAssert) checkInt(this, value, offset, 2, 0xffff, 0)
  this[offset] = (value & 0xff)
  this[offset + 1] = (value >>> 8)
  return offset + 2
}

Buffer.prototype.writeUInt16BE = function writeUInt16BE (value, offset, noAssert) {
  value = +value
  offset = offset >>> 0
  if (!noAssert) checkInt(this, value, offset, 2, 0xffff, 0)
  this[offset] = (value >>> 8)
  this[offset + 1] = (value & 0xff)
  return offset + 2
}

Buffer.prototype.writeUInt32LE = function writeUInt32LE (value, offset, noAssert) {
  value = +value
  offset = offset >>> 0
  if (!noAssert) checkInt(this, value, offset, 4, 0xffffffff, 0)
  this[offset + 3] = (value >>> 24)
  this[offset + 2] = (value >>> 16)
  this[offset + 1] = (value >>> 8)
  this[offset] = (value & 0xff)
  return offset + 4
}

Buffer.prototype.writeUInt32BE = function writeUInt32BE (value, offset, noAssert) {
  value = +value
  offset = offset >>> 0
  if (!noAssert) checkInt(this, value, offset, 4, 0xffffffff, 0)
  this[offset] = (value >>> 24)
  this[offset + 1] = (value >>> 16)
  this[offset + 2] = (value >>> 8)
  this[offset + 3] = (value & 0xff)
  return offset + 4
}

Buffer.prototype.writeIntLE = function writeIntLE (value, offset, byteLength, noAssert) {
  value = +value
  offset = offset >>> 0
  if (!noAssert) {
    var limit = Math.pow(2, (8 * byteLength) - 1)

    checkInt(this, value, offset, byteLength, limit - 1, -limit)
  }

  var i = 0
  var mul = 1
  var sub = 0
  this[offset] = value & 0xFF
  while (++i < byteLength && (mul *= 0x100)) {
    if (value < 0 && sub === 0 && this[offset + i - 1] !== 0) {
      sub = 1
    }
    this[offset + i] = ((value / mul) >> 0) - sub & 0xFF
  }

  return offset + byteLength
}

Buffer.prototype.writeIntBE = function writeIntBE (value, offset, byteLength, noAssert) {
  value = +value
  offset = offset >>> 0
  if (!noAssert) {
    var limit = Math.pow(2, (8 * byteLength) - 1)

    checkInt(this, value, offset, byteLength, limit - 1, -limit)
  }

  var i = byteLength - 1
  var mul = 1
  var sub = 0
  this[offset + i] = value & 0xFF
  while (--i >= 0 && (mul *= 0x100)) {
    if (value < 0 && sub === 0 && this[offset + i + 1] !== 0) {
      sub = 1
    }
    this[offset + i] = ((value / mul) >> 0) - sub & 0xFF
  }

  return offset + byteLength
}

Buffer.prototype.writeInt8 = function writeInt8 (value, offset, noAssert) {
  value = +value
  offset = offset >>> 0
  if (!noAssert) checkInt(this, value, offset, 1, 0x7f, -0x80)
  if (value < 0) value = 0xff + value + 1
  this[offset] = (value & 0xff)
  return offset + 1
}

Buffer.prototype.writeInt16LE = function writeInt16LE (value, offset, noAssert) {
  value = +value
  offset = offset >>> 0
  if (!noAssert) checkInt(this, value, offset, 2, 0x7fff, -0x8000)
  this[offset] = (value & 0xff)
  this[offset + 1] = (value >>> 8)
  return offset + 2
}

Buffer.prototype.writeInt16BE = function writeInt16BE (value, offset, noAssert) {
  value = +value
  offset = offset >>> 0
  if (!noAssert) checkInt(this, value, offset, 2, 0x7fff, -0x8000)
  this[offset] = (value >>> 8)
  this[offset + 1] = (value & 0xff)
  return offset + 2
}

Buffer.prototype.writeInt32LE = function writeInt32LE (value, offset, noAssert) {
  value = +value
  offset = offset >>> 0
  if (!noAssert) checkInt(this, value, offset, 4, 0x7fffffff, -0x80000000)
  this[offset] = (value & 0xff)
  this[offset + 1] = (value >>> 8)
  this[offset + 2] = (value >>> 16)
  this[offset + 3] = (value >>> 24)
  return offset + 4
}

Buffer.prototype.writeInt32BE = function writeInt32BE (value, offset, noAssert) {
  value = +value
  offset = offset >>> 0
  if (!noAssert) checkInt(this, value, offset, 4, 0x7fffffff, -0x80000000)
  if (value < 0) value = 0xffffffff + value + 1
  this[offset] = (value >>> 24)
  this[offset + 1] = (value >>> 16)
  this[offset + 2] = (value >>> 8)
  this[offset + 3] = (value & 0xff)
  return offset + 4
}

function checkIEEE754 (buf, value, offset, ext, max, min) {
  if (offset + ext > buf.length) throw new RangeError('Index out of range')
  if (offset < 0) throw new RangeError('Index out of range')
}

function writeFloat (buf, value, offset, littleEndian, noAssert) {
  value = +value
  offset = offset >>> 0
  if (!noAssert) {
    checkIEEE754(buf, value, offset, 4, 3.4028234663852886e+38, -3.4028234663852886e+38)
  }
  ieee754.write(buf, value, offset, littleEndian, 23, 4)
  return offset + 4
}

Buffer.prototype.writeFloatLE = function writeFloatLE (value, offset, noAssert) {
  return writeFloat(this, value, offset, true, noAssert)
}

Buffer.prototype.writeFloatBE = function writeFloatBE (value, offset, noAssert) {
  return writeFloat(this, value, offset, false, noAssert)
}

function writeDouble (buf, value, offset, littleEndian, noAssert) {
  value = +value
  offset = offset >>> 0
  if (!noAssert) {
    checkIEEE754(buf, value, offset, 8, 1.7976931348623157E+308, -1.7976931348623157E+308)
  }
  ieee754.write(buf, value, offset, littleEndian, 52, 8)
  return offset + 8
}

Buffer.prototype.writeDoubleLE = function writeDoubleLE (value, offset, noAssert) {
  return writeDouble(this, value, offset, true, noAssert)
}

Buffer.prototype.writeDoubleBE = function writeDoubleBE (value, offset, noAssert) {
  return writeDouble(this, value, offset, false, noAssert)
}

// copy(targetBuffer, targetStart=0, sourceStart=0, sourceEnd=buffer.length)
Buffer.prototype.copy = function copy (target, targetStart, start, end) {
  if (!Buffer.isBuffer(target)) throw new TypeError('argument should be a Buffer')
  if (!start) start = 0
  if (!end && end !== 0) end = this.length
  if (targetStart >= target.length) targetStart = target.length
  if (!targetStart) targetStart = 0
  if (end > 0 && end < start) end = start

  // Copy 0 bytes; we're done
  if (end === start) return 0
  if (target.length === 0 || this.length === 0) return 0

  // Fatal error conditions
  if (targetStart < 0) {
    throw new RangeError('targetStart out of bounds')
  }
  if (start < 0 || start >= this.length) throw new RangeError('Index out of range')
  if (end < 0) throw new RangeError('sourceEnd out of bounds')

  // Are we oob?
  if (end > this.length) end = this.length
  if (target.length - targetStart < end - start) {
    end = target.length - targetStart + start
  }

  var len = end - start

  if (this === target && typeof Uint8Array.prototype.copyWithin === 'function') {
    // Use built-in when available, missing from IE11
    this.copyWithin(targetStart, start, end)
  } else if (this === target && start < targetStart && targetStart < end) {
    // descending copy from end
    for (var i = len - 1; i >= 0; --i) {
      target[i + targetStart] = this[i + start]
    }
  } else {
    Uint8Array.prototype.set.call(
      target,
      this.subarray(start, end),
      targetStart
    )
  }

  return len
}

// Usage:
//    buffer.fill(number[, offset[, end]])
//    buffer.fill(buffer[, offset[, end]])
//    buffer.fill(string[, offset[, end]][, encoding])
Buffer.prototype.fill = function fill (val, start, end, encoding) {
  // Handle string cases:
  if (typeof val === 'string') {
    if (typeof start === 'string') {
      encoding = start
      start = 0
      end = this.length
    } else if (typeof end === 'string') {
      encoding = end
      end = this.length
    }
    if (encoding !== undefined && typeof encoding !== 'string') {
      throw new TypeError('encoding must be a string')
    }
    if (typeof encoding === 'string' && !Buffer.isEncoding(encoding)) {
      throw new TypeError('Unknown encoding: ' + encoding)
    }
    if (val.length === 1) {
      var code = val.charCodeAt(0)
      if ((encoding === 'utf8' && code < 128) ||
          encoding === 'latin1') {
        // Fast path: If `val` fits into a single byte, use that numeric value.
        val = code
      }
    }
  } else if (typeof val === 'number') {
    val = val & 255
  }

  // Invalid ranges are not set to a default, so can range check early.
  if (start < 0 || this.length < start || this.length < end) {
    throw new RangeError('Out of range index')
  }

  if (end <= start) {
    return this
  }

  start = start >>> 0
  end = end === undefined ? this.length : end >>> 0

  if (!val) val = 0

  var i
  if (typeof val === 'number') {
    for (i = start; i < end; ++i) {
      this[i] = val
    }
  } else {
    var bytes = Buffer.isBuffer(val)
      ? val
      : Buffer.from(val, encoding)
    var len = bytes.length
    if (len === 0) {
      throw new TypeError('The value "' + val +
        '" is invalid for argument "value"')
    }
    for (i = 0; i < end - start; ++i) {
      this[i + start] = bytes[i % len]
    }
  }

  return this
}

// HELPER FUNCTIONS
// ================

var INVALID_BASE64_RE = /[^+/0-9A-Za-z-_]/g

function base64clean (str) {
  // Node takes equal signs as end of the Base64 encoding
  str = str.split('=')[0]
  // Node strips out invalid characters like \n and \t from the string, base64-js does not
  str = str.trim().replace(INVALID_BASE64_RE, '')
  // Node converts strings with length < 2 to ''
  if (str.length < 2) return ''
  // Node allows for non-padded base64 strings (missing trailing ===), base64-js does not
  while (str.length % 4 !== 0) {
    str = str + '='
  }
  return str
}

function toHex (n) {
  if (n < 16) return '0' + n.toString(16)
  return n.toString(16)
}

function utf8ToBytes (string, units) {
  units = units || Infinity
  var codePoint
  var length = string.length
  var leadSurrogate = null
  var bytes = []

  for (var i = 0; i < length; ++i) {
    codePoint = string.charCodeAt(i)

    // is surrogate component
    if (codePoint > 0xD7FF && codePoint < 0xE000) {
      // last char was a lead
      if (!leadSurrogate) {
        // no lead yet
        if (codePoint > 0xDBFF) {
          // unexpected trail
          if ((units -= 3) > -1) bytes.push(0xEF, 0xBF, 0xBD)
          continue
        } else if (i + 1 === length) {
          // unpaired lead
          if ((units -= 3) > -1) bytes.push(0xEF, 0xBF, 0xBD)
          continue
        }

        // valid lead
        leadSurrogate = codePoint

        continue
      }

      // 2 leads in a row
      if (codePoint < 0xDC00) {
        if ((units -= 3) > -1) bytes.push(0xEF, 0xBF, 0xBD)
        leadSurrogate = codePoint
        continue
      }

      // valid surrogate pair
      codePoint = (leadSurrogate - 0xD800 << 10 | codePoint - 0xDC00) + 0x10000
    } else if (leadSurrogate) {
      // valid bmp char, but last char was a lead
      if ((units -= 3) > -1) bytes.push(0xEF, 0xBF, 0xBD)
    }

    leadSurrogate = null

    // encode utf8
    if (codePoint < 0x80) {
      if ((units -= 1) < 0) break
      bytes.push(codePoint)
    } else if (codePoint < 0x800) {
      if ((units -= 2) < 0) break
      bytes.push(
        codePoint >> 0x6 | 0xC0,
        codePoint & 0x3F | 0x80
      )
    } else if (codePoint < 0x10000) {
      if ((units -= 3) < 0) break
      bytes.push(
        codePoint >> 0xC | 0xE0,
        codePoint >> 0x6 & 0x3F | 0x80,
        codePoint & 0x3F | 0x80
      )
    } else if (codePoint < 0x110000) {
      if ((units -= 4) < 0) break
      bytes.push(
        codePoint >> 0x12 | 0xF0,
        codePoint >> 0xC & 0x3F | 0x80,
        codePoint >> 0x6 & 0x3F | 0x80,
        codePoint & 0x3F | 0x80
      )
    } else {
      throw new Error('Invalid code point')
    }
  }

  return bytes
}

function asciiToBytes (str) {
  var byteArray = []
  for (var i = 0; i < str.length; ++i) {
    // Node's code seems to be doing this and not & 0x7F..
    byteArray.push(str.charCodeAt(i) & 0xFF)
  }
  return byteArray
}

function utf16leToBytes (str, units) {
  var c, hi, lo
  var byteArray = []
  for (var i = 0; i < str.length; ++i) {
    if ((units -= 2) < 0) break

    c = str.charCodeAt(i)
    hi = c >> 8
    lo = c % 256
    byteArray.push(lo)
    byteArray.push(hi)
  }

  return byteArray
}

function base64ToBytes (str) {
  return base64.toByteArray(base64clean(str))
}

function blitBuffer (src, dst, offset, length) {
  for (var i = 0; i < length; ++i) {
    if ((i + offset >= dst.length) || (i >= src.length)) break
    dst[i + offset] = src[i]
  }
  return i
}

// ArrayBuffer or Uint8Array objects from other contexts (i.e. iframes) do not pass
// the `instanceof` check but they should be treated as of that type.
// See: https://github.com/feross/buffer/issues/166
function isInstance (obj, type) {
  return obj instanceof type ||
    (obj != null && obj.constructor != null && obj.constructor.name != null &&
      obj.constructor.name === type.name)
}
function numberIsNaN (obj) {
  // For IE11 support
  return obj !== obj // eslint-disable-line no-self-compare
}

},{"base64-js":4,"ieee754":10}],6:[function(require,module,exports){
var charenc = {
  // UTF-8 encoding
  utf8: {
    // Convert a string to a byte array
    stringToBytes: function(str) {
      return charenc.bin.stringToBytes(unescape(encodeURIComponent(str)));
    },

    // Convert a byte array to a string
    bytesToString: function(bytes) {
      return decodeURIComponent(escape(charenc.bin.bytesToString(bytes)));
    }
  },

  // Binary encoding
  bin: {
    // Convert a string to a byte array
    stringToBytes: function(str) {
      for (var bytes = [], i = 0; i < str.length; i++)
        bytes.push(str.charCodeAt(i) & 0xFF);
      return bytes;
    },

    // Convert a byte array to a string
    bytesToString: function(bytes) {
      for (var str = [], i = 0; i < bytes.length; i++)
        str.push(String.fromCharCode(bytes[i]));
      return str.join('');
    }
  }
};

module.exports = charenc;

},{}],7:[function(require,module,exports){
/** Wrap an API that uses callbacks with Promises
 * This expects the pattern function withCallback(arg1, arg2, ... argN, callback)
 * @author Keith Henry <keith.henry@evolutionjobs.co.uk>
 * @license MIT */
(function () {
    'use strict';

    /** Wrap a function with a callback with a Promise.
     * @param {function} f The function to wrap, should be pattern: withCallback(arg1, arg2, ... argN, callback).
     * @param {function} parseCB Optional function to parse multiple callback parameters into a single object.
     * @returns {Promise} Promise that resolves when the callback fires. */
    function promisify(f, parseCB) {
        return (...args) => {
            let safeArgs = args;
            let callback;
            // The Chrome API functions all use arguments, so we can't use f.length to check

            // If there is a last arg
            if (args && args.length > 0) {

                // ... and the last arg is a function
                const last = args[args.length - 1];
                if (typeof last === 'function') {
                    // Trim the last callback arg if it's been passed
                    safeArgs = args.slice(0, args.length - 1);
                    callback = last;
                }
            }

            // Return a promise
            return new Promise((resolve, reject) => {
                try {
                    // Try to run the original function, with the trimmed args list
                    f(...safeArgs, (...cbArgs) => {

                        // If a callback was passed at the end of the original arguments
                        if (callback) {
                            // Don't allow a bug in the callback to stop the promise resolving
                            try { callback(...cbArgs); }
                            catch (cbErr) { reject(cbErr); }
                        }

                        // Chrome extensions always fire the callback, but populate chrome.runtime.lastError with exception details
                        if (chrome.runtime.lastError)
                            // Return as an error for the awaited catch block
                            reject(new Error(chrome.runtime.lastError.message || `Error thrown by API ${chrome.runtime.lastError}`));
                        else {
                            if (parseCB) {
                                const cbObj = parseCB(...cbArgs);
                                resolve(cbObj);
                            }
                            else if (!cbArgs || cbArgs.length === 0)
                                resolve();
                            else if (cbArgs.length === 1)
                                resolve(cbArgs[0]);
                            else
                                resolve(cbArgs);
                        }
                    });
                }
                catch (err) { reject(err); }
            });
        }
    }

    /** Promisify all the known functions in the map 
     * @param {object} api The Chrome native API to extend
     * @param {Array} apiMap Collection of sub-API and functions to promisify */
    function applyMap(api, apiMap) {
        if (!api)
            // Not supported by current permissions
            return;

        for (let funcDef of apiMap) {
            let funcName;
            if (typeof funcDef === 'string')
                funcName = funcDef;
            else {
                funcName = funcDef.n;
            }

            if (!api.hasOwnProperty(funcName))
                // Member not in API
                continue;

            const m = api[funcName];
            if (typeof m === 'function')
                // This is a function, wrap in a promise
                api[funcName] = promisify(m.bind(api), funcDef.cb);
            else
                // Sub-API, recurse this func with the mapped props
                applyMap(m, funcDef.props);
        }
    }

    /** Apply promise-maps to the Chrome native API.
     * @param {object} apiMaps The API to apply. */
    function applyMaps(apiMaps) {
        for (let apiName in apiMaps) {
            const callbackApi = chrome[apiName];
            if (!callbackApi)
                // Not supported by current permissions
                continue;

            const apiMap = apiMaps[apiName];
            applyMap(callbackApi, apiMap);
        }
    }

    // accessibilityFeatures https://developer.chrome.com/extensions/accessibilityFeatures
    const knownA11ySetting = ['get', 'set', 'clear'];

    // ContentSetting https://developer.chrome.com/extensions/contentSettings#type-ContentSetting
    const knownInContentSetting = ['clear', 'get', 'set', 'getResourceIdentifiers'];

    // StorageArea https://developer.chrome.com/extensions/storage#type-StorageArea
    const knownInStorageArea = ['get', 'getBytesInUse', 'set', 'remove', 'clear'];

    /** Map of API functions that follow the callback pattern that we can 'promisify' */
    applyMaps({
        accessibilityFeatures: [  // Todo: this should extend AccessibilityFeaturesSetting.prototype instead
            { n: 'spokenFeedback', props: knownA11ySetting },
            { n: 'largeCursor', props: knownA11ySetting },
            { n: 'stickyKeys', props: knownA11ySetting },
            { n: 'highContrast', props: knownA11ySetting },
            { n: 'screenMagnifier', props: knownA11ySetting },
            { n: 'autoclick', props: knownA11ySetting },
            { n: 'virtualKeyboard', props: knownA11ySetting },
            { n: 'animationPolicy', props: knownA11ySetting }],
        alarms: ['get', 'getAll', 'clear', 'clearAll'],
        bookmarks: [
            'get', 'getChildren', 'getRecent', 'getTree', 'getSubTree',
            'search', 'create', 'move', 'update', 'remove', 'removeTree'],
        browser: ['openTab'],
        browserAction: [
            'getTitle', 'setIcon', 'getPopup', 'getBadgeText', 'getBadgeBackgroundColor'],
        browsingData: [
            'settings', 'remove', 'removeAppcache', 'removeCache',
            'removeCookies', 'removeDownloads', 'removeFileSystems',
            'removeFormData', 'removeHistory', 'removeIndexedDB',
            'removeLocalStorage', 'removePluginData', 'removePasswords',
            'removeWebSQL'],
        commands: ['getAll'],
        contentSettings: [  // Todo: this should extend ContentSetting.prototype instead
            { n: 'cookies', props: knownInContentSetting },
            { n: 'images', props: knownInContentSetting },
            { n: 'javascript', props: knownInContentSetting },
            { n: 'location', props: knownInContentSetting },
            { n: 'plugins', props: knownInContentSetting },
            { n: 'popups', props: knownInContentSetting },
            { n: 'notifications', props: knownInContentSetting },
            { n: 'fullscreen', props: knownInContentSetting },
            { n: 'mouselock', props: knownInContentSetting },
            { n: 'microphone', props: knownInContentSetting },
            { n: 'camera', props: knownInContentSetting },
            { n: 'unsandboxedPlugins', props: knownInContentSetting },
            { n: 'automaticDownloads', props: knownInContentSetting }],
        contextMenus: ['create', 'update', 'remove', 'removeAll'],
        cookies: ['get', 'getAll', 'set', 'remove', 'getAllCookieStores'],
        debugger: ['attach', 'detach', 'sendCommand', 'getTargets'],
        desktopCapture: ['chooseDesktopMedia'],
        // TODO: devtools.*
        documentScan: ['scan'],
        downloads: [
            'download', 'search', 'pause', 'resume', 'cancel',
            'getFileIcon', 'erase', 'removeFile', 'acceptDanger'],
        enterprise: [{ n: 'platformKeys', props: ['getToken', 'getCertificates', 'importCertificate', 'removeCertificate'] }],
        extension: ['isAllowedIncognitoAccess', 'isAllowedFileSchemeAccess'], // mostly deprecated in favour of runtime
        fileBrowserHandler: ['selectFile'],
        fileSystemProvider: ['mount', 'unmount', 'getAll', 'get', 'notify'],
        fontSettings: [
            'setDefaultFontSize', 'getFont', 'getDefaultFontSize', 'getMinimumFontSize',
            'setMinimumFontSize', 'getDefaultFixedFontSize', 'clearDefaultFontSize',
            'setDefaultFixedFontSize', 'clearFont', 'setFont', 'clearMinimumFontSize',
            'getFontList', 'clearDefaultFixedFontSize'],
        gcm: ['register', 'unregister', 'send'],
        history: ['search', 'getVisits', 'addUrl', 'deleteUrl', 'deleteRange', 'deleteAll'],
        i18n: ['getAcceptLanguages', 'detectLanguage'],
        identity: [
            'getAuthToken', 'getProfileUserInfo', 'removeCachedAuthToken', 'launchWebAuthFlow'],
        idle: ['queryState'],
        input: [{
            n: 'ime', props: [
                'setMenuItems', 'commitText', 'setCandidates', 'setComposition', 'updateMenuItems',
                'setCandidateWindowProperties', 'clearComposition', 'setCursorPosition', 'sendKeyEvents',
                'deleteSurroundingText']
        }],
        management: [
            'setEnabled', 'getPermissionWarningsById', 'get', 'getAll',
            'getPermissionWarningsByManifest', 'launchApp', 'uninstall', 'getSelf',
            'uninstallSelf', 'createAppShortcut', 'setLaunchType', 'generateAppForLink'],
        networking: [{ n: 'config', props: ['setNetworkFilter', 'finishAuthentication'] }],
        notifications: ['create', 'update', 'clear', 'getAll', 'getPermissionLevel'],
        pageAction: ['getTitle', 'setIcon', 'getPopup'],
        pageCapture: ['saveAsMHTML'],
        permissions: ['getAll', 'contains', 'request', 'remove'],
        platformKeys: ['selectClientCertificates', 'verifyTLSServerCertificate',
            { n: "getKeyPair", cb: (publicKey, privateKey) => { return { publicKey, privateKey }; } }],
        runtime: [
            'getBackgroundPage', 'openOptionsPage', 'setUninstallURL',
            'restartAfterDelay', 'sendMessage',
            'sendNativeMessage', 'getPlatformInfo', 'getPackageDirectoryEntry',
            { n: "requestUpdateCheck", cb: (status, details) => { return { status, details }; } }],
        scriptBadge: ['getPopup'],
        sessions: ['getRecentlyClosed', 'getDevices', 'restore'],
        storage: [          // Todo: this should extend StorageArea.prototype instead
            { n: 'sync', props: knownInStorageArea },
            { n: 'local', props: knownInStorageArea },
            { n: 'managed', props: knownInStorageArea }],
        socket: [
            'create', 'connect', 'bind', 'read', 'write', 'recvFrom', 'sendTo',
            'listen', 'accept', 'setKeepAlive', 'setNoDelay', 'getInfo', 'getNetworkList'],
        sockets: [
            { n: 'tcp', props: [
                'create','update','setPaused','setKeepAlive','setNoDelay','connect',
                'disconnect','secure','send','close','getInfo','getSockets'] },
            { n: 'tcpServer', props: [
                'create','update','setPaused','listen','disconnect','close','getInfo','getSockets'] }, 
            { n: 'udp', props: [
                'create','update','setPaused','bind','send','close','getInfo',
                'getSockets','joinGroup','leaveGroup','setMulticastTimeToLive',
                'setMulticastLoopbackMode','getJoinedGroups','setBroadcast'] }],
        system: [
            { n: 'cpu', props: ['getInfo'] },
            { n: 'memory', props: ['getInfo'] },
            { n: 'storage', props: ['getInfo', 'ejectDevice', 'getAvailableCapacity'] }],
        tabCapture: ['capture', 'getCapturedTabs'],
        tabs: [
            'get', 'getCurrent', 'sendMessage', 'create', 'duplicate',
            'query', 'highlight', 'update', 'move', 'reload', 'remove',
            'detectLanguage', 'captureVisibleTab', 'executeScript',
            'insertCSS', 'setZoom', 'getZoom', 'setZoomSettings',
            'getZoomSettings', 'discard'],
        topSites: ['get'],
        tts: ['isSpeaking', 'getVoices', 'speak'],
        types: ['set', 'get', 'clear'],
        vpnProvider: ['createConfig', 'destroyConfig', 'setParameters', 'sendPacket', 'notifyConnectionStateChanged'],
        wallpaper: ['setWallpaper'],
        webNavigation: ['getFrame', 'getAllFrames', 'handlerBehaviorChanged'],
        windows: ['get', 'getCurrent', 'getLastFocused', 'getAll', 'create', 'update', 'remove']
    });
})();

},{}],8:[function(require,module,exports){
(function() {
  var base64map
      = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/',

  crypt = {
    // Bit-wise rotation left
    rotl: function(n, b) {
      return (n << b) | (n >>> (32 - b));
    },

    // Bit-wise rotation right
    rotr: function(n, b) {
      return (n << (32 - b)) | (n >>> b);
    },

    // Swap big-endian to little-endian and vice versa
    endian: function(n) {
      // If number given, swap endian
      if (n.constructor == Number) {
        return crypt.rotl(n, 8) & 0x00FF00FF | crypt.rotl(n, 24) & 0xFF00FF00;
      }

      // Else, assume array and swap all items
      for (var i = 0; i < n.length; i++)
        n[i] = crypt.endian(n[i]);
      return n;
    },

    // Generate an array of any length of random bytes
    randomBytes: function(n) {
      for (var bytes = []; n > 0; n--)
        bytes.push(Math.floor(Math.random() * 256));
      return bytes;
    },

    // Convert a byte array to big-endian 32-bit words
    bytesToWords: function(bytes) {
      for (var words = [], i = 0, b = 0; i < bytes.length; i++, b += 8)
        words[b >>> 5] |= bytes[i] << (24 - b % 32);
      return words;
    },

    // Convert big-endian 32-bit words to a byte array
    wordsToBytes: function(words) {
      for (var bytes = [], b = 0; b < words.length * 32; b += 8)
        bytes.push((words[b >>> 5] >>> (24 - b % 32)) & 0xFF);
      return bytes;
    },

    // Convert a byte array to a hex string
    bytesToHex: function(bytes) {
      for (var hex = [], i = 0; i < bytes.length; i++) {
        hex.push((bytes[i] >>> 4).toString(16));
        hex.push((bytes[i] & 0xF).toString(16));
      }
      return hex.join('');
    },

    // Convert a hex string to a byte array
    hexToBytes: function(hex) {
      for (var bytes = [], c = 0; c < hex.length; c += 2)
        bytes.push(parseInt(hex.substr(c, 2), 16));
      return bytes;
    },

    // Convert a byte array to a base-64 string
    bytesToBase64: function(bytes) {
      for (var base64 = [], i = 0; i < bytes.length; i += 3) {
        var triplet = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
        for (var j = 0; j < 4; j++)
          if (i * 8 + j * 6 <= bytes.length * 8)
            base64.push(base64map.charAt((triplet >>> 6 * (3 - j)) & 0x3F));
          else
            base64.push('=');
      }
      return base64.join('');
    },

    // Convert a base-64 string to a byte array
    base64ToBytes: function(base64) {
      // Remove non-base-64 characters
      base64 = base64.replace(/[^A-Z0-9+\/]/ig, '');

      for (var bytes = [], i = 0, imod4 = 0; i < base64.length;
          imod4 = ++i % 4) {
        if (imod4 == 0) continue;
        bytes.push(((base64map.indexOf(base64.charAt(i - 1))
            & (Math.pow(2, -2 * imod4 + 8) - 1)) << (imod4 * 2))
            | (base64map.indexOf(base64.charAt(i)) >>> (6 - imod4 * 2)));
      }
      return bytes;
    }
  };

  module.exports = crypt;
})();

},{}],9:[function(require,module,exports){
(function (setImmediate){
/*
WHAT: SublimeText-like Fuzzy Search

USAGE:
  fuzzysort.single('fs', 'Fuzzy Search') // {score: -16}
  fuzzysort.single('test', 'test') // {score: 0}
  fuzzysort.single('doesnt exist', 'target') // null

  fuzzysort.go('mr', ['Monitor.cpp', 'MeshRenderer.cpp'])
  // [{score: -18, target: "MeshRenderer.cpp"}, {score: -6009, target: "Monitor.cpp"}]

  fuzzysort.highlight(fuzzysort.single('fs', 'Fuzzy Search'), '<b>', '</b>')
  // <b>F</b>uzzy <b>S</b>earch
*/

// UMD (Universal Module Definition) for fuzzysort
;(function(root, UMD) {
  if(typeof define === 'function' && define.amd) define([], UMD)
  else if(typeof module === 'object' && module.exports) module.exports = UMD()
  else root.fuzzysort = UMD()
})(this, function UMD() { function fuzzysortNew(instanceOptions) {

  var fuzzysort = {

    single: function(search, target, options) {
      if(!search) return null
      if(!isObj(search)) search = fuzzysort.getPreparedSearch(search)

      if(!target) return null
      if(!isObj(target)) target = fuzzysort.getPrepared(target)

      var allowTypo = options && options.allowTypo!==undefined ? options.allowTypo
        : instanceOptions && instanceOptions.allowTypo!==undefined ? instanceOptions.allowTypo
        : true
      var algorithm = allowTypo ? fuzzysort.algorithm : fuzzysort.algorithmNoTypo
      return algorithm(search, target, search[0])
      // var threshold = options && options.threshold || instanceOptions && instanceOptions.threshold || -9007199254740991
      // var result = algorithm(search, target, search[0])
      // if(result === null) return null
      // if(result.score < threshold) return null
      // return result
    },

    go: function(search, targets, options) {
      if(!search) return noResults
      search = fuzzysort.prepareSearch(search)
      var searchLowerCode = search[0]

      var threshold = options && options.threshold || instanceOptions && instanceOptions.threshold || -9007199254740991
      var limit = options && options.limit || instanceOptions && instanceOptions.limit || 9007199254740991
      var allowTypo = options && options.allowTypo!==undefined ? options.allowTypo
        : instanceOptions && instanceOptions.allowTypo!==undefined ? instanceOptions.allowTypo
        : true
      var algorithm = allowTypo ? fuzzysort.algorithm : fuzzysort.algorithmNoTypo
      var resultsLen = 0; var limitedCount = 0
      var targetsLen = targets.length

      // This code is copy/pasted 3 times for performance reasons [options.keys, options.key, no keys]

      // options.keys
      if(options && options.keys) {
        var scoreFn = options.scoreFn || defaultScoreFn
        var keys = options.keys
        var keysLen = keys.length
        for(var i = targetsLen - 1; i >= 0; --i) { var obj = targets[i]
          var objResults = new Array(keysLen)
          for (var keyI = keysLen - 1; keyI >= 0; --keyI) {
            var key = keys[keyI]
            var target = getValue(obj, key)
            if(!target) { objResults[keyI] = null; continue }
            if(!isObj(target)) target = fuzzysort.getPrepared(target)

            objResults[keyI] = algorithm(search, target, searchLowerCode)
          }
          objResults.obj = obj // before scoreFn so scoreFn can use it
          var score = scoreFn(objResults)
          if(score === null) continue
          if(score < threshold) continue
          objResults.score = score
          if(resultsLen < limit) { q.add(objResults); ++resultsLen }
          else {
            ++limitedCount
            if(score > q.peek().score) q.replaceTop(objResults)
          }
        }

      // options.key
      } else if(options && options.key) {
        var key = options.key
        for(var i = targetsLen - 1; i >= 0; --i) { var obj = targets[i]
          var target = getValue(obj, key)
          if(!target) continue
          if(!isObj(target)) target = fuzzysort.getPrepared(target)

          var result = algorithm(search, target, searchLowerCode)
          if(result === null) continue
          if(result.score < threshold) continue

          // have to clone result so duplicate targets from different obj can each reference the correct obj
          result = {target:result.target, _targetLowerCodes:null, _nextBeginningIndexes:null, score:result.score, indexes:result.indexes, obj:obj} // hidden

          if(resultsLen < limit) { q.add(result); ++resultsLen }
          else {
            ++limitedCount
            if(result.score > q.peek().score) q.replaceTop(result)
          }
        }

      // no keys
      } else {
        for(var i = targetsLen - 1; i >= 0; --i) { var target = targets[i]
          if(!target) continue
          if(!isObj(target)) target = fuzzysort.getPrepared(target)

          var result = algorithm(search, target, searchLowerCode)
          if(result === null) continue
          if(result.score < threshold) continue
          if(resultsLen < limit) { q.add(result); ++resultsLen }
          else {
            ++limitedCount
            if(result.score > q.peek().score) q.replaceTop(result)
          }
        }
      }

      if(resultsLen === 0) return noResults
      var results = new Array(resultsLen)
      for(var i = resultsLen - 1; i >= 0; --i) results[i] = q.poll()
      results.total = resultsLen + limitedCount
      return results
    },

    goAsync: function(search, targets, options) {
      var canceled = false
      var p = new Promise(function(resolve, reject) {
        if(!search) return resolve(noResults)
        search = fuzzysort.prepareSearch(search)
        var searchLowerCode = search[0]

        var q = fastpriorityqueue()
        var iCurrent = targets.length - 1
        var threshold = options && options.threshold || instanceOptions && instanceOptions.threshold || -9007199254740991
        var limit = options && options.limit || instanceOptions && instanceOptions.limit || 9007199254740991
        var allowTypo = options && options.allowTypo!==undefined ? options.allowTypo
          : instanceOptions && instanceOptions.allowTypo!==undefined ? instanceOptions.allowTypo
          : true
        var algorithm = allowTypo ? fuzzysort.algorithm : fuzzysort.algorithmNoTypo
        var resultsLen = 0; var limitedCount = 0
        function step() {
          if(canceled) return reject('canceled')

          var startMs = Date.now()

          // This code is copy/pasted 3 times for performance reasons [options.keys, options.key, no keys]

          // options.keys
          if(options && options.keys) {
            var scoreFn = options.scoreFn || defaultScoreFn
            var keys = options.keys
            var keysLen = keys.length
            for(; iCurrent >= 0; --iCurrent) { var obj = targets[iCurrent]
              var objResults = new Array(keysLen)
              for (var keyI = keysLen - 1; keyI >= 0; --keyI) {
                var key = keys[keyI]
                var target = getValue(obj, key)
                if(!target) { objResults[keyI] = null; continue }
                if(!isObj(target)) target = fuzzysort.getPrepared(target)

                objResults[keyI] = algorithm(search, target, searchLowerCode)
              }
              objResults.obj = obj // before scoreFn so scoreFn can use it
              var score = scoreFn(objResults)
              if(score === null) continue
              if(score < threshold) continue
              objResults.score = score
              if(resultsLen < limit) { q.add(objResults); ++resultsLen }
              else {
                ++limitedCount
                if(score > q.peek().score) q.replaceTop(objResults)
              }

              if(iCurrent%1000/*itemsPerCheck*/ === 0) {
                if(Date.now() - startMs >= 10/*asyncInterval*/) {
                  isNode?setImmediate(step):setTimeout(step)
                  return
                }
              }
            }

          // options.key
          } else if(options && options.key) {
            var key = options.key
            for(; iCurrent >= 0; --iCurrent) { var obj = targets[iCurrent]
              var target = getValue(obj, key)
              if(!target) continue
              if(!isObj(target)) target = fuzzysort.getPrepared(target)

              var result = algorithm(search, target, searchLowerCode)
              if(result === null) continue
              if(result.score < threshold) continue

              // have to clone result so duplicate targets from different obj can each reference the correct obj
              result = {target:result.target, _targetLowerCodes:null, _nextBeginningIndexes:null, score:result.score, indexes:result.indexes, obj:obj} // hidden

              if(resultsLen < limit) { q.add(result); ++resultsLen }
              else {
                ++limitedCount
                if(result.score > q.peek().score) q.replaceTop(result)
              }

              if(iCurrent%1000/*itemsPerCheck*/ === 0) {
                if(Date.now() - startMs >= 10/*asyncInterval*/) {
                  isNode?setImmediate(step):setTimeout(step)
                  return
                }
              }
            }

          // no keys
          } else {
            for(; iCurrent >= 0; --iCurrent) { var target = targets[iCurrent]
              if(!target) continue
              if(!isObj(target)) target = fuzzysort.getPrepared(target)

              var result = algorithm(search, target, searchLowerCode)
              if(result === null) continue
              if(result.score < threshold) continue
              if(resultsLen < limit) { q.add(result); ++resultsLen }
              else {
                ++limitedCount
                if(result.score > q.peek().score) q.replaceTop(result)
              }

              if(iCurrent%1000/*itemsPerCheck*/ === 0) {
                if(Date.now() - startMs >= 10/*asyncInterval*/) {
                  isNode?setImmediate(step):setTimeout(step)
                  return
                }
              }
            }
          }

          if(resultsLen === 0) return resolve(noResults)
          var results = new Array(resultsLen)
          for(var i = resultsLen - 1; i >= 0; --i) results[i] = q.poll()
          results.total = resultsLen + limitedCount
          resolve(results)
        }

        isNode?setImmediate(step):step()
      })
      p.cancel = function() { canceled = true }
      return p
    },

    highlight: function(result, hOpen, hClose) {
      if(result === null) return null
      if(hOpen === undefined) hOpen = '<b>'
      if(hClose === undefined) hClose = '</b>'
      var highlighted = ''
      var matchesIndex = 0
      var opened = false
      var target = result.target
      var targetLen = target.length
      var matchesBest = result.indexes
      for(var i = 0; i < targetLen; ++i) { var char = target[i]
        if(matchesBest[matchesIndex] === i) {
          ++matchesIndex
          if(!opened) { opened = true
            highlighted += hOpen
          }

          if(matchesIndex === matchesBest.length) {
            highlighted += char + hClose + target.substr(i+1)
            break
          }
        } else {
          if(opened) { opened = false
            highlighted += hClose
          }
        }
        highlighted += char
      }

      return highlighted
    },

    prepare: function(target) {
      if(!target) return
      return {target:target, _targetLowerCodes:fuzzysort.prepareLowerCodes(target), _nextBeginningIndexes:null, score:null, indexes:null, obj:null} // hidden
    },
    prepareSlow: function(target) {
      if(!target) return
      return {target:target, _targetLowerCodes:fuzzysort.prepareLowerCodes(target), _nextBeginningIndexes:fuzzysort.prepareNextBeginningIndexes(target), score:null, indexes:null, obj:null} // hidden
    },
    prepareSearch: function(search) {
      if(!search) return
      return fuzzysort.prepareLowerCodes(search)
    },



    // Below this point is only internal code
    // Below this point is only internal code
    // Below this point is only internal code
    // Below this point is only internal code



    getPrepared: function(target) {
      if(target.length > 999) return fuzzysort.prepare(target) // don't cache huge targets
      var targetPrepared = preparedCache.get(target)
      if(targetPrepared !== undefined) return targetPrepared
      targetPrepared = fuzzysort.prepare(target)
      preparedCache.set(target, targetPrepared)
      return targetPrepared
    },
    getPreparedSearch: function(search) {
      if(search.length > 999) return fuzzysort.prepareSearch(search) // don't cache huge searches
      var searchPrepared = preparedSearchCache.get(search)
      if(searchPrepared !== undefined) return searchPrepared
      searchPrepared = fuzzysort.prepareSearch(search)
      preparedSearchCache.set(search, searchPrepared)
      return searchPrepared
    },

    algorithm: function(searchLowerCodes, prepared, searchLowerCode) {
      var targetLowerCodes = prepared._targetLowerCodes
      var searchLen = searchLowerCodes.length
      var targetLen = targetLowerCodes.length
      var searchI = 0 // where we at
      var targetI = 0 // where you at
      var typoSimpleI = 0
      var matchesSimpleLen = 0

      // very basic fuzzy match; to remove non-matching targets ASAP!
      // walk through target. find sequential matches.
      // if all chars aren't found then exit
      for(;;) {
        var isMatch = searchLowerCode === targetLowerCodes[targetI]
        if(isMatch) {
          matchesSimple[matchesSimpleLen++] = targetI
          ++searchI; if(searchI === searchLen) break
          searchLowerCode = searchLowerCodes[typoSimpleI===0?searchI : (typoSimpleI===searchI?searchI+1 : (typoSimpleI===searchI-1?searchI-1 : searchI))]
        }

        ++targetI; if(targetI >= targetLen) { // Failed to find searchI
          // Check for typo or exit
          // we go as far as possible before trying to transpose
          // then we transpose backwards until we reach the beginning
          for(;;) {
            if(searchI <= 1) return null // not allowed to transpose first char
            if(typoSimpleI === 0) { // we haven't tried to transpose yet
              --searchI
              var searchLowerCodeNew = searchLowerCodes[searchI]
              if(searchLowerCode === searchLowerCodeNew) continue // doesn't make sense to transpose a repeat char
              typoSimpleI = searchI
            } else {
              if(typoSimpleI === 1) return null // reached the end of the line for transposing
              --typoSimpleI
              searchI = typoSimpleI
              searchLowerCode = searchLowerCodes[searchI + 1]
              var searchLowerCodeNew = searchLowerCodes[searchI]
              if(searchLowerCode === searchLowerCodeNew) continue // doesn't make sense to transpose a repeat char
            }
            matchesSimpleLen = searchI
            targetI = matchesSimple[matchesSimpleLen - 1] + 1
            break
          }
        }
      }

      var searchI = 0
      var typoStrictI = 0
      var successStrict = false
      var matchesStrictLen = 0

      var nextBeginningIndexes = prepared._nextBeginningIndexes
      if(nextBeginningIndexes === null) nextBeginningIndexes = prepared._nextBeginningIndexes = fuzzysort.prepareNextBeginningIndexes(prepared.target)
      var firstPossibleI = targetI = matchesSimple[0]===0 ? 0 : nextBeginningIndexes[matchesSimple[0]-1]

      // Our target string successfully matched all characters in sequence!
      // Let's try a more advanced and strict test to improve the score
      // only count it as a match if it's consecutive or a beginning character!
      if(targetI !== targetLen) for(;;) {
        if(targetI >= targetLen) {
          // We failed to find a good spot for this search char, go back to the previous search char and force it forward
          if(searchI <= 0) { // We failed to push chars forward for a better match
            // transpose, starting from the beginning
            ++typoStrictI; if(typoStrictI > searchLen-2) break
            if(searchLowerCodes[typoStrictI] === searchLowerCodes[typoStrictI+1]) continue // doesn't make sense to transpose a repeat char
            targetI = firstPossibleI
            continue
          }

          --searchI
          var lastMatch = matchesStrict[--matchesStrictLen]
          targetI = nextBeginningIndexes[lastMatch]

        } else {
          var isMatch = searchLowerCodes[typoStrictI===0?searchI : (typoStrictI===searchI?searchI+1 : (typoStrictI===searchI-1?searchI-1 : searchI))] === targetLowerCodes[targetI]
          if(isMatch) {
            matchesStrict[matchesStrictLen++] = targetI
            ++searchI; if(searchI === searchLen) { successStrict = true; break }
            ++targetI
          } else {
            targetI = nextBeginningIndexes[targetI]
          }
        }
      }

      { // tally up the score & keep track of matches for highlighting later
        if(successStrict) { var matchesBest = matchesStrict; var matchesBestLen = matchesStrictLen }
        else { var matchesBest = matchesSimple; var matchesBestLen = matchesSimpleLen }
        var score = 0
        var lastTargetI = -1
        for(var i = 0; i < searchLen; ++i) { var targetI = matchesBest[i]
          // score only goes down if they're not consecutive
          if(lastTargetI !== targetI - 1) score -= targetI
          lastTargetI = targetI
        }
        if(!successStrict) {
          score *= 1000
          if(typoSimpleI !== 0) score += -20/*typoPenalty*/
        } else {
          if(typoStrictI !== 0) score += -20/*typoPenalty*/
        }
        score -= targetLen - searchLen
        prepared.score = score
        prepared.indexes = new Array(matchesBestLen); for(var i = matchesBestLen - 1; i >= 0; --i) prepared.indexes[i] = matchesBest[i]

        return prepared
      }
    },

    algorithmNoTypo: function(searchLowerCodes, prepared, searchLowerCode) {
      var targetLowerCodes = prepared._targetLowerCodes
      var searchLen = searchLowerCodes.length
      var targetLen = targetLowerCodes.length
      var searchI = 0 // where we at
      var targetI = 0 // where you at
      var matchesSimpleLen = 0

      // very basic fuzzy match; to remove non-matching targets ASAP!
      // walk through target. find sequential matches.
      // if all chars aren't found then exit
      for(;;) {
        var isMatch = searchLowerCode === targetLowerCodes[targetI]
        if(isMatch) {
          matchesSimple[matchesSimpleLen++] = targetI
          ++searchI; if(searchI === searchLen) break
          searchLowerCode = searchLowerCodes[searchI]
        }
        ++targetI; if(targetI >= targetLen) return null // Failed to find searchI
      }

      var searchI = 0
      var successStrict = false
      var matchesStrictLen = 0

      var nextBeginningIndexes = prepared._nextBeginningIndexes
      if(nextBeginningIndexes === null) nextBeginningIndexes = prepared._nextBeginningIndexes = fuzzysort.prepareNextBeginningIndexes(prepared.target)
      var firstPossibleI = targetI = matchesSimple[0]===0 ? 0 : nextBeginningIndexes[matchesSimple[0]-1]

      // Our target string successfully matched all characters in sequence!
      // Let's try a more advanced and strict test to improve the score
      // only count it as a match if it's consecutive or a beginning character!
      if(targetI !== targetLen) for(;;) {
        if(targetI >= targetLen) {
          // We failed to find a good spot for this search char, go back to the previous search char and force it forward
          if(searchI <= 0) break // We failed to push chars forward for a better match

          --searchI
          var lastMatch = matchesStrict[--matchesStrictLen]
          targetI = nextBeginningIndexes[lastMatch]

        } else {
          var isMatch = searchLowerCodes[searchI] === targetLowerCodes[targetI]
          if(isMatch) {
            matchesStrict[matchesStrictLen++] = targetI
            ++searchI; if(searchI === searchLen) { successStrict = true; break }
            ++targetI
          } else {
            targetI = nextBeginningIndexes[targetI]
          }
        }
      }

      { // tally up the score & keep track of matches for highlighting later
        if(successStrict) { var matchesBest = matchesStrict; var matchesBestLen = matchesStrictLen }
        else { var matchesBest = matchesSimple; var matchesBestLen = matchesSimpleLen }
        var score = 0
        var lastTargetI = -1
        for(var i = 0; i < searchLen; ++i) { var targetI = matchesBest[i]
          // score only goes down if they're not consecutive
          if(lastTargetI !== targetI - 1) score -= targetI
          lastTargetI = targetI
        }
        if(!successStrict) score *= 1000
        score -= targetLen - searchLen
        prepared.score = score
        prepared.indexes = new Array(matchesBestLen); for(var i = matchesBestLen - 1; i >= 0; --i) prepared.indexes[i] = matchesBest[i]

        return prepared
      }
    },

    prepareLowerCodes: function(str) {
      var strLen = str.length
      var lowerCodes = [] // new Array(strLen)    sparse array is too slow
      var lower = str.toLowerCase()
      for(var i = 0; i < strLen; ++i) lowerCodes[i] = lower.charCodeAt(i)
      return lowerCodes
    },
    prepareBeginningIndexes: function(target) {
      var targetLen = target.length
      var beginningIndexes = []; var beginningIndexesLen = 0
      var wasUpper = false
      var wasAlphanum = false
      for(var i = 0; i < targetLen; ++i) {
        var targetCode = target.charCodeAt(i)
        var isUpper = targetCode>=65&&targetCode<=90
        var isAlphanum = isUpper || targetCode>=97&&targetCode<=122 || targetCode>=48&&targetCode<=57
        var isBeginning = isUpper && !wasUpper || !wasAlphanum || !isAlphanum
        wasUpper = isUpper
        wasAlphanum = isAlphanum
        if(isBeginning) beginningIndexes[beginningIndexesLen++] = i
      }
      return beginningIndexes
    },
    prepareNextBeginningIndexes: function(target) {
      var targetLen = target.length
      var beginningIndexes = fuzzysort.prepareBeginningIndexes(target)
      var nextBeginningIndexes = [] // new Array(targetLen)     sparse array is too slow
      var lastIsBeginning = beginningIndexes[0]
      var lastIsBeginningI = 0
      for(var i = 0; i < targetLen; ++i) {
        if(lastIsBeginning > i) {
          nextBeginningIndexes[i] = lastIsBeginning
        } else {
          lastIsBeginning = beginningIndexes[++lastIsBeginningI]
          nextBeginningIndexes[i] = lastIsBeginning===undefined ? targetLen : lastIsBeginning
        }
      }
      return nextBeginningIndexes
    },

    cleanup: cleanup,
    new: fuzzysortNew,
  }
  return fuzzysort
} // fuzzysortNew

// This stuff is outside fuzzysortNew, because it's shared with instances of fuzzysort.new()
var isNode = typeof require !== 'undefined' && typeof window === 'undefined'
// var MAX_INT = Number.MAX_SAFE_INTEGER
// var MIN_INT = Number.MIN_VALUE
var preparedCache = new Map()
var preparedSearchCache = new Map()
var noResults = []; noResults.total = 0
var matchesSimple = []; var matchesStrict = []
function cleanup() { preparedCache.clear(); preparedSearchCache.clear(); matchesSimple = []; matchesStrict = [] }
function defaultScoreFn(a) {
  var max = -9007199254740991
  for (var i = a.length - 1; i >= 0; --i) {
    var result = a[i]; if(result === null) continue
    var score = result.score
    if(score > max) max = score
  }
  if(max === -9007199254740991) return null
  return max
}

// prop = 'key'              2.5ms optimized for this case, seems to be about as fast as direct obj[prop]
// prop = 'key1.key2'        10ms
// prop = ['key1', 'key2']   27ms
function getValue(obj, prop) {
  var tmp = obj[prop]; if(tmp !== undefined) return tmp
  var segs = prop
  if(!Array.isArray(prop)) segs = prop.split('.')
  var len = segs.length
  var i = -1
  while (obj && (++i < len)) obj = obj[segs[i]]
  return obj
}

function isObj(x) { return typeof x === 'object' } // faster as a function

// Hacked version of https://github.com/lemire/FastPriorityQueue.js
var fastpriorityqueue=function(){var r=[],o=0,e={};function n(){for(var e=0,n=r[e],c=1;c<o;){var f=c+1;e=c,f<o&&r[f].score<r[c].score&&(e=f),r[e-1>>1]=r[e],c=1+(e<<1)}for(var a=e-1>>1;e>0&&n.score<r[a].score;a=(e=a)-1>>1)r[e]=r[a];r[e]=n}return e.add=function(e){var n=o;r[o++]=e;for(var c=n-1>>1;n>0&&e.score<r[c].score;c=(n=c)-1>>1)r[n]=r[c];r[n]=e},e.poll=function(){if(0!==o){var e=r[0];return r[0]=r[--o],n(),e}},e.peek=function(e){if(0!==o)return r[0]},e.replaceTop=function(o){r[0]=o,n()},e};
var q = fastpriorityqueue() // reuse this, except for async, it needs to make its own

return fuzzysortNew()
}) // UMD

// TODO: (performance) wasm version!?

// TODO: (performance) layout memory in an optimal way to go fast by avoiding cache misses

// TODO: (performance) preparedCache is a memory leak

// TODO: (like sublime) backslash === forwardslash

// TODO: (performance) i have no idea how well optizmied the allowing typos algorithm is

}).call(this,require("timers").setImmediate)
},{"timers":17}],10:[function(require,module,exports){
exports.read = function (buffer, offset, isLE, mLen, nBytes) {
  var e, m
  var eLen = (nBytes * 8) - mLen - 1
  var eMax = (1 << eLen) - 1
  var eBias = eMax >> 1
  var nBits = -7
  var i = isLE ? (nBytes - 1) : 0
  var d = isLE ? -1 : 1
  var s = buffer[offset + i]

  i += d

  e = s & ((1 << (-nBits)) - 1)
  s >>= (-nBits)
  nBits += eLen
  for (; nBits > 0; e = (e * 256) + buffer[offset + i], i += d, nBits -= 8) {}

  m = e & ((1 << (-nBits)) - 1)
  e >>= (-nBits)
  nBits += mLen
  for (; nBits > 0; m = (m * 256) + buffer[offset + i], i += d, nBits -= 8) {}

  if (e === 0) {
    e = 1 - eBias
  } else if (e === eMax) {
    return m ? NaN : ((s ? -1 : 1) * Infinity)
  } else {
    m = m + Math.pow(2, mLen)
    e = e - eBias
  }
  return (s ? -1 : 1) * m * Math.pow(2, e - mLen)
}

exports.write = function (buffer, value, offset, isLE, mLen, nBytes) {
  var e, m, c
  var eLen = (nBytes * 8) - mLen - 1
  var eMax = (1 << eLen) - 1
  var eBias = eMax >> 1
  var rt = (mLen === 23 ? Math.pow(2, -24) - Math.pow(2, -77) : 0)
  var i = isLE ? 0 : (nBytes - 1)
  var d = isLE ? 1 : -1
  var s = value < 0 || (value === 0 && 1 / value < 0) ? 1 : 0

  value = Math.abs(value)

  if (isNaN(value) || value === Infinity) {
    m = isNaN(value) ? 1 : 0
    e = eMax
  } else {
    e = Math.floor(Math.log(value) / Math.LN2)
    if (value * (c = Math.pow(2, -e)) < 1) {
      e--
      c *= 2
    }
    if (e + eBias >= 1) {
      value += rt / c
    } else {
      value += rt * Math.pow(2, 1 - eBias)
    }
    if (value * c >= 2) {
      e++
      c /= 2
    }

    if (e + eBias >= eMax) {
      m = 0
      e = eMax
    } else if (e + eBias >= 1) {
      m = ((value * c) - 1) * Math.pow(2, mLen)
      e = e + eBias
    } else {
      m = value * Math.pow(2, eBias - 1) * Math.pow(2, mLen)
      e = 0
    }
  }

  for (; mLen >= 8; buffer[offset + i] = m & 0xff, i += d, m /= 256, mLen -= 8) {}

  e = (e << mLen) | m
  eLen += mLen
  for (; eLen > 0; buffer[offset + i] = e & 0xff, i += d, e /= 256, eLen -= 8) {}

  buffer[offset + i - d] |= s * 128
}

},{}],11:[function(require,module,exports){
(function (process){
// A simple implementation of make-array
function makeArray (subject) {
  return Array.isArray(subject)
    ? subject
    : [subject]
}

const REGEX_TEST_BLANK_LINE = /^\s+$/
const REGEX_REPLACE_LEADING_EXCAPED_EXCLAMATION = /^\\!/
const REGEX_REPLACE_LEADING_EXCAPED_HASH = /^\\#/
const REGEX_SPLITALL_CRLF = /\r?\n/g
// /foo,
// ./foo,
// ../foo,
// .
// ..
const REGEX_TEST_INVALID_PATH = /^\.*\/|^\.+$/

const SLASH = '/'
const KEY_IGNORE = typeof Symbol !== 'undefined'
  ? Symbol.for('node-ignore')
  /* istanbul ignore next */
  : 'node-ignore'

const define = (object, key, value) =>
  Object.defineProperty(object, key, {value})

const REGEX_REGEXP_RANGE = /([0-z])-([0-z])/g

// Sanitize the range of a regular expression
// The cases are complicated, see test cases for details
const sanitizeRange = range => range.replace(
  REGEX_REGEXP_RANGE,
  (match, from, to) => from.charCodeAt(0) <= to.charCodeAt(0)
    ? match
    // Invalid range (out of order) which is ok for gitignore rules but
    //   fatal for JavaScript regular expression, so eliminate it.
    : ''
)

// > If the pattern ends with a slash,
// > it is removed for the purpose of the following description,
// > but it would only find a match with a directory.
// > In other words, foo/ will match a directory foo and paths underneath it,
// > but will not match a regular file or a symbolic link foo
// >  (this is consistent with the way how pathspec works in general in Git).
// '`foo/`' will not match regular file '`foo`' or symbolic link '`foo`'
// -> ignore-rules will not deal with it, because it costs extra `fs.stat` call
//      you could use option `mark: true` with `glob`

// '`foo/`' should not continue with the '`..`'
const REPLACERS = [

  // > Trailing spaces are ignored unless they are quoted with backslash ("\")
  [
    // (a\ ) -> (a )
    // (a  ) -> (a)
    // (a \ ) -> (a  )
    /\\?\s+$/,
    match => match.indexOf('\\') === 0
      ? ' '
      : ''
  ],

  // replace (\ ) with ' '
  [
    /\\\s/g,
    () => ' '
  ],

  // Escape metacharacters
  // which is written down by users but means special for regular expressions.

  // > There are 12 characters with special meanings:
  // > - the backslash \,
  // > - the caret ^,
  // > - the dollar sign $,
  // > - the period or dot .,
  // > - the vertical bar or pipe symbol |,
  // > - the question mark ?,
  // > - the asterisk or star *,
  // > - the plus sign +,
  // > - the opening parenthesis (,
  // > - the closing parenthesis ),
  // > - and the opening square bracket [,
  // > - the opening curly brace {,
  // > These special characters are often called "metacharacters".
  [
    /[\\^$.|*+(){]/g,
    match => `\\${match}`
  ],

  [
    // > [abc] matches any character inside the brackets
    // >    (in this case a, b, or c);
    /\[([^\]/]*)($|\])/g,
    (match, p1, p2) => p2 === ']'
      ? `[${sanitizeRange(p1)}]`
      : `\\${match}`
  ],

  [
    // > a question mark (?) matches a single character
    /(?!\\)\?/g,
    () => '[^/]'
  ],

  // leading slash
  [

    // > A leading slash matches the beginning of the pathname.
    // > For example, "/*.c" matches "cat-file.c" but not "mozilla-sha1/sha1.c".
    // A leading slash matches the beginning of the pathname
    /^\//,
    () => '^'
  ],

  // replace special metacharacter slash after the leading slash
  [
    /\//g,
    () => '\\/'
  ],

  [
    // > A leading "**" followed by a slash means match in all directories.
    // > For example, "**/foo" matches file or directory "foo" anywhere,
    // > the same as pattern "foo".
    // > "**/foo/bar" matches file or directory "bar" anywhere that is directly
    // >   under directory "foo".
    // Notice that the '*'s have been replaced as '\\*'
    /^\^*\\\*\\\*\\\//,

    // '**/foo' <-> 'foo'
    () => '^(?:.*\\/)?'
  ],

  // ending
  [
    // 'js' will not match 'js.'
    // 'ab' will not match 'abc'
    /(?:[^*])$/,

    // WTF!
    // https://git-scm.com/docs/gitignore
    // changes in [2.22.1](https://git-scm.com/docs/gitignore/2.22.1)
    // which re-fixes #24, #38

    // > If there is a separator at the end of the pattern then the pattern
    // > will only match directories, otherwise the pattern can match both
    // > files and directories.

    // 'js*' will not match 'a.js'
    // 'js/' will not match 'a.js'
    // 'js' will match 'a.js' and 'a.js/'
    match => /\/$/.test(match)
      // foo/ will not match 'foo'
      ? `${match}$`
      // foo matches 'foo' and 'foo/'
      : `${match}(?=$|\\/$)`
  ],

  // starting
  [
    // there will be no leading '/'
    //   (which has been replaced by section "leading slash")
    // If starts with '**', adding a '^' to the regular expression also works
    /^(?=[^^])/,
    function startingReplacer () {
      // If has a slash `/` at the beginning or middle
      return !/\/(?!$)/.test(this)
        // > Prior to 2.22.1
        // > If the pattern does not contain a slash /,
        // >   Git treats it as a shell glob pattern
        // Actually, if there is only a trailing slash,
        //   git also treats it as a shell glob pattern

        // After 2.22.1 (compatible but clearer)
        // > If there is a separator at the beginning or middle (or both)
        // > of the pattern, then the pattern is relative to the directory
        // > level of the particular .gitignore file itself.
        // > Otherwise the pattern may also match at any level below
        // > the .gitignore level.
        ? '(?:^|\\/)'

        // > Otherwise, Git treats the pattern as a shell glob suitable for
        // >   consumption by fnmatch(3)
        : '^'
    }
  ],

  // two globstars
  [
    // Use lookahead assertions so that we could match more than one `'/**'`
    /\\\/\\\*\\\*(?=\\\/|$)/g,

    // Zero, one or several directories
    // should not use '*', or it will be replaced by the next replacer

    // Check if it is not the last `'/**'`
    (_, index, str) => index + 6 < str.length

      // case: /**/
      // > A slash followed by two consecutive asterisks then a slash matches
      // >   zero or more directories.
      // > For example, "a/**/b" matches "a/b", "a/x/b", "a/x/y/b" and so on.
      // '/**/'
      ? '(?:\\/[^\\/]+)*'

      // case: /**
      // > A trailing `"/**"` matches everything inside.

      // #21: everything inside but it should not include the current folder
      : '\\/.+'
  ],

  // intermediate wildcards
  [
    // Never replace escaped '*'
    // ignore rule '\*' will match the path '*'

    // 'abc.*/' -> go
    // 'abc.*'  -> skip this rule
    /(^|[^\\]+)\\\*(?=.+)/g,

    // '*.js' matches '.js'
    // '*.js' doesn't match 'abc'
    (_, p1) => `${p1}[^\\/]*`
  ],

  // trailing wildcard
  [
    /(\^|\\\/)?\\\*$/,
    (_, p1) => {
      const prefix = p1
        // '\^':
        // '/*' does not match ''
        // '/*' does not match everything

        // '\\\/':
        // 'abc/*' does not match 'abc/'
        ? `${p1}[^/]+`

        // 'a*' matches 'a'
        // 'a*' matches 'aa'
        : '[^/]*'

      return `${prefix}(?=$|\\/$)`
    }
  ],

  [
    // unescape
    /\\\\\\/g,
    () => '\\'
  ]
]

// A simple cache, because an ignore rule only has only one certain meaning
const regexCache = Object.create(null)

// @param {pattern}
const makeRegex = (pattern, negative, ignorecase) => {
  const r = regexCache[pattern]
  if (r) {
    return r
  }

  // const replacers = negative
  //   ? NEGATIVE_REPLACERS
  //   : POSITIVE_REPLACERS

  const source = REPLACERS.reduce(
    (prev, current) => prev.replace(current[0], current[1].bind(pattern)),
    pattern
  )

  return regexCache[pattern] = ignorecase
    ? new RegExp(source, 'i')
    : new RegExp(source)
}

const isString = subject => typeof subject === 'string'

// > A blank line matches no files, so it can serve as a separator for readability.
const checkPattern = pattern => pattern
  && isString(pattern)
  && !REGEX_TEST_BLANK_LINE.test(pattern)

  // > A line starting with # serves as a comment.
  && pattern.indexOf('#') !== 0

const splitPattern = pattern => pattern.split(REGEX_SPLITALL_CRLF)

class IgnoreRule {
  constructor (
    origin,
    pattern,
    negative,
    regex
  ) {
    this.origin = origin
    this.pattern = pattern
    this.negative = negative
    this.regex = regex
  }
}

const createRule = (pattern, ignorecase) => {
  const origin = pattern
  let negative = false

  // > An optional prefix "!" which negates the pattern;
  if (pattern.indexOf('!') === 0) {
    negative = true
    pattern = pattern.substr(1)
  }

  pattern = pattern
  // > Put a backslash ("\") in front of the first "!" for patterns that
  // >   begin with a literal "!", for example, `"\!important!.txt"`.
  .replace(REGEX_REPLACE_LEADING_EXCAPED_EXCLAMATION, '!')
  // > Put a backslash ("\") in front of the first hash for patterns that
  // >   begin with a hash.
  .replace(REGEX_REPLACE_LEADING_EXCAPED_HASH, '#')

  const regex = makeRegex(pattern, negative, ignorecase)

  return new IgnoreRule(
    origin,
    pattern,
    negative,
    regex
  )
}

const throwError = (message, Ctor) => {
  throw new Ctor(message)
}

const checkPath = (path, originalPath, doThrow) => {
  if (!isString(path)) {
    return doThrow(
      `path must be a string, but got \`${originalPath}\``,
      TypeError
    )
  }

  // We don't know if we should ignore '', so throw
  if (!path) {
    return doThrow(`path must not be empty`, TypeError)
  }

  // Check if it is a relative path
  if (checkPath.isNotRelative(path)) {
    const r = '`path.relative()`d'
    return doThrow(
      `path should be a ${r} string, but got "${originalPath}"`,
      RangeError
    )
  }

  return true
}

const isNotRelative = path => REGEX_TEST_INVALID_PATH.test(path)

checkPath.isNotRelative = isNotRelative
checkPath.convert = p => p

class Ignore {
  constructor ({
    ignorecase = true
  } = {}) {
    this._rules = []
    this._ignorecase = ignorecase
    define(this, KEY_IGNORE, true)
    this._initCache()
  }

  _initCache () {
    this._ignoreCache = Object.create(null)
    this._testCache = Object.create(null)
  }

  _addPattern (pattern) {
    // #32
    if (pattern && pattern[KEY_IGNORE]) {
      this._rules = this._rules.concat(pattern._rules)
      this._added = true
      return
    }

    if (checkPattern(pattern)) {
      const rule = createRule(pattern, this._ignorecase)
      this._added = true
      this._rules.push(rule)
    }
  }

  // @param {Array<string> | string | Ignore} pattern
  add (pattern) {
    this._added = false

    makeArray(
      isString(pattern)
        ? splitPattern(pattern)
        : pattern
    ).forEach(this._addPattern, this)

    // Some rules have just added to the ignore,
    // making the behavior changed.
    if (this._added) {
      this._initCache()
    }

    return this
  }

  // legacy
  addPattern (pattern) {
    return this.add(pattern)
  }

  //          |           ignored : unignored
  // negative |   0:0   |   0:1   |   1:0   |   1:1
  // -------- | ------- | ------- | ------- | --------
  //     0    |  TEST   |  TEST   |  SKIP   |    X
  //     1    |  TESTIF |  SKIP   |  TEST   |    X

  // - SKIP: always skip
  // - TEST: always test
  // - TESTIF: only test if checkUnignored
  // - X: that never happen

  // @param {boolean} whether should check if the path is unignored,
  //   setting `checkUnignored` to `false` could reduce additional
  //   path matching.

  // @returns {TestResult} true if a file is ignored
  _testOne (path, checkUnignored) {
    let ignored = false
    let unignored = false

    this._rules.forEach(rule => {
      const {negative} = rule
      if (
        unignored === negative && ignored !== unignored
        || negative && !ignored && !unignored && !checkUnignored
      ) {
        return
      }

      const matched = rule.regex.test(path)

      if (matched) {
        ignored = !negative
        unignored = negative
      }
    })

    return {
      ignored,
      unignored
    }
  }

  // @returns {TestResult}
  _test (originalPath, cache, checkUnignored, slices) {
    const path = originalPath
      // Supports nullable path
      && checkPath.convert(originalPath)

    checkPath(path, originalPath, throwError)

    return this._t(path, cache, checkUnignored, slices)
  }

  _t (path, cache, checkUnignored, slices) {
    if (path in cache) {
      return cache[path]
    }

    if (!slices) {
      // path/to/a.js
      // ['path', 'to', 'a.js']
      slices = path.split(SLASH)
    }

    slices.pop()

    // If the path has no parent directory, just test it
    if (!slices.length) {
      return cache[path] = this._testOne(path, checkUnignored)
    }

    const parent = this._t(
      slices.join(SLASH) + SLASH,
      cache,
      checkUnignored,
      slices
    )

    // If the path contains a parent directory, check the parent first
    return cache[path] = parent.ignored
      // > It is not possible to re-include a file if a parent directory of
      // >   that file is excluded.
      ? parent
      : this._testOne(path, checkUnignored)
  }

  ignores (path) {
    return this._test(path, this._ignoreCache, false).ignored
  }

  createFilter () {
    return path => !this.ignores(path)
  }

  filter (paths) {
    return makeArray(paths).filter(this.createFilter())
  }

  // @returns {TestResult}
  test (path) {
    return this._test(path, this._testCache, true)
  }
}

const factory = options => new Ignore(options)

const returnFalse = () => false

const isPathValid = path =>
  checkPath(path && checkPath.convert(path), path, returnFalse)

factory.isPathValid = isPathValid

// Fixes typescript
factory.default = factory

module.exports = factory

// Windows
// --------------------------------------------------------------
/* istanbul ignore if  */
if (
  // Detect `process` so that it can run in browsers.
  typeof process !== 'undefined'
  && (
    process.env && process.env.IGNORE_TEST_WIN32
    || process.platform === 'win32'
  )
) {
  /* eslint no-control-regex: "off" */
  const makePosix = str => /^\\\\\?\\/.test(str)
  || /["<>|\u0000-\u001F]+/u.test(str)
    ? str
    : str.replace(/\\/g, '/')

  checkPath.convert = makePosix

  // 'C:\\foo'     <- 'C:\\foo' has been converted to 'C:/'
  // 'd:\\foo'
  const REGIX_IS_WINDOWS_PATH_ABSOLUTE = /^[a-z]:\//i
  checkPath.isNotRelative = path =>
    REGIX_IS_WINDOWS_PATH_ABSOLUTE.test(path)
    || isNotRelative(path)
}

}).call(this,require('_process'))
},{"_process":14}],12:[function(require,module,exports){
(function (global,setImmediate){
;(function() {
"use strict"
function Vnode(tag, key, attrs0, children, text, dom) {
	return {tag: tag, key: key, attrs: attrs0, children: children, text: text, dom: dom, domSize: undefined, state: undefined, _state: undefined, events: undefined, instance: undefined, skip: false}
}
Vnode.normalize = function(node) {
	if (Array.isArray(node)) return Vnode("[", undefined, undefined, Vnode.normalizeChildren(node), undefined, undefined)
	if (node != null && typeof node !== "object") return Vnode("#", undefined, undefined, node === false ? "" : node, undefined, undefined)
	return node
}
Vnode.normalizeChildren = function normalizeChildren(children) {
	for (var i = 0; i < children.length; i++) {
		children[i] = Vnode.normalize(children[i])
	}
	return children
}
var selectorParser = /(?:(^|#|\.)([^#\.\[\]]+))|(\[(.+?)(?:\s*=\s*("|'|)((?:\\["'\]]|.)*?)\5)?\])/g
var selectorCache = {}
var hasOwn = {}.hasOwnProperty
function isEmpty(object) {
	for (var key in object) if (hasOwn.call(object, key)) return false
	return true
}
function compileSelector(selector) {
	var match, tag = "div", classes = [], attrs = {}
	while (match = selectorParser.exec(selector)) {
		var type = match[1], value = match[2]
		if (type === "" && value !== "") tag = value
		else if (type === "#") attrs.id = value
		else if (type === ".") classes.push(value)
		else if (match[3][0] === "[") {
			var attrValue = match[6]
			if (attrValue) attrValue = attrValue.replace(/\\(["'])/g, "$1").replace(/\\\\/g, "\\")
			if (match[4] === "class") classes.push(attrValue)
			else attrs[match[4]] = attrValue === "" ? attrValue : attrValue || true
		}
	}
	if (classes.length > 0) attrs.className = classes.join(" ")
	return selectorCache[selector] = {tag: tag, attrs: attrs}
}
function execSelector(state, attrs, children) {
	var hasAttrs = false, childList, text
	var className = attrs.className || attrs.class
	if (!isEmpty(state.attrs) && !isEmpty(attrs)) {
		var newAttrs = {}
		for(var key in attrs) {
			if (hasOwn.call(attrs, key)) {
				newAttrs[key] = attrs[key]
			}
		}
		attrs = newAttrs
	}
	for (var key in state.attrs) {
		if (hasOwn.call(state.attrs, key)) {
			attrs[key] = state.attrs[key]
		}
	}
	if (className !== undefined) {
		if (attrs.class !== undefined) {
			attrs.class = undefined
			attrs.className = className
		}
		if (state.attrs.className != null) {
			attrs.className = state.attrs.className + " " + className
		}
	}
	for (var key in attrs) {
		if (hasOwn.call(attrs, key) && key !== "key") {
			hasAttrs = true
			break
		}
	}
	if (Array.isArray(children) && children.length === 1 && children[0] != null && children[0].tag === "#") {
		text = children[0].children
	} else {
		childList = children
	}
	return Vnode(state.tag, attrs.key, hasAttrs ? attrs : undefined, childList, text)
}
function hyperscript(selector) {
	// Because sloppy mode sucks
	var attrs = arguments[1], start = 2, children
	if (selector == null || typeof selector !== "string" && typeof selector !== "function" && typeof selector.view !== "function") {
		throw Error("The selector must be either a string or a component.");
	}
	if (typeof selector === "string") {
		var cached = selectorCache[selector] || compileSelector(selector)
	}
	if (attrs == null) {
		attrs = {}
	} else if (typeof attrs !== "object" || attrs.tag != null || Array.isArray(attrs)) {
		attrs = {}
		start = 1
	}
	if (arguments.length === start + 1) {
		children = arguments[start]
		if (!Array.isArray(children)) children = [children]
	} else {
		children = []
		while (start < arguments.length) children.push(arguments[start++])
	}
	var normalized = Vnode.normalizeChildren(children)
	if (typeof selector === "string") {
		return execSelector(cached, attrs, normalized)
	} else {
		return Vnode(selector, attrs.key, attrs, normalized)
	}
}
hyperscript.trust = function(html) {
	if (html == null) html = ""
	return Vnode("<", undefined, undefined, html, undefined, undefined)
}
hyperscript.fragment = function(attrs1, children) {
	return Vnode("[", attrs1.key, attrs1, Vnode.normalizeChildren(children), undefined, undefined)
}
var m = hyperscript
/** @constructor */
var PromisePolyfill = function(executor) {
	if (!(this instanceof PromisePolyfill)) throw new Error("Promise must be called with `new`")
	if (typeof executor !== "function") throw new TypeError("executor must be a function")
	var self = this, resolvers = [], rejectors = [], resolveCurrent = handler(resolvers, true), rejectCurrent = handler(rejectors, false)
	var instance = self._instance = {resolvers: resolvers, rejectors: rejectors}
	var callAsync = typeof setImmediate === "function" ? setImmediate : setTimeout
	function handler(list, shouldAbsorb) {
		return function execute(value) {
			var then
			try {
				if (shouldAbsorb && value != null && (typeof value === "object" || typeof value === "function") && typeof (then = value.then) === "function") {
					if (value === self) throw new TypeError("Promise can't be resolved w/ itself")
					executeOnce(then.bind(value))
				}
				else {
					callAsync(function() {
						if (!shouldAbsorb && list.length === 0) console.error("Possible unhandled promise rejection:", value)
						for (var i = 0; i < list.length; i++) list[i](value)
						resolvers.length = 0, rejectors.length = 0
						instance.state = shouldAbsorb
						instance.retry = function() {execute(value)}
					})
				}
			}
			catch (e) {
				rejectCurrent(e)
			}
		}
	}
	function executeOnce(then) {
		var runs = 0
		function run(fn) {
			return function(value) {
				if (runs++ > 0) return
				fn(value)
			}
		}
		var onerror = run(rejectCurrent)
		try {then(run(resolveCurrent), onerror)} catch (e) {onerror(e)}
	}
	executeOnce(executor)
}
PromisePolyfill.prototype.then = function(onFulfilled, onRejection) {
	var self = this, instance = self._instance
	function handle(callback, list, next, state) {
		list.push(function(value) {
			if (typeof callback !== "function") next(value)
			else try {resolveNext(callback(value))} catch (e) {if (rejectNext) rejectNext(e)}
		})
		if (typeof instance.retry === "function" && state === instance.state) instance.retry()
	}
	var resolveNext, rejectNext
	var promise = new PromisePolyfill(function(resolve, reject) {resolveNext = resolve, rejectNext = reject})
	handle(onFulfilled, instance.resolvers, resolveNext, true), handle(onRejection, instance.rejectors, rejectNext, false)
	return promise
}
PromisePolyfill.prototype.catch = function(onRejection) {
	return this.then(null, onRejection)
}
PromisePolyfill.resolve = function(value) {
	if (value instanceof PromisePolyfill) return value
	return new PromisePolyfill(function(resolve) {resolve(value)})
}
PromisePolyfill.reject = function(value) {
	return new PromisePolyfill(function(resolve, reject) {reject(value)})
}
PromisePolyfill.all = function(list) {
	return new PromisePolyfill(function(resolve, reject) {
		var total = list.length, count = 0, values = []
		if (list.length === 0) resolve([])
		else for (var i = 0; i < list.length; i++) {
			(function(i) {
				function consume(value) {
					count++
					values[i] = value
					if (count === total) resolve(values)
				}
				if (list[i] != null && (typeof list[i] === "object" || typeof list[i] === "function") && typeof list[i].then === "function") {
					list[i].then(consume, reject)
				}
				else consume(list[i])
			})(i)
		}
	})
}
PromisePolyfill.race = function(list) {
	return new PromisePolyfill(function(resolve, reject) {
		for (var i = 0; i < list.length; i++) {
			list[i].then(resolve, reject)
		}
	})
}
if (typeof window !== "undefined") {
	if (typeof window.Promise === "undefined") window.Promise = PromisePolyfill
	var PromisePolyfill = window.Promise
} else if (typeof global !== "undefined") {
	if (typeof global.Promise === "undefined") global.Promise = PromisePolyfill
	var PromisePolyfill = global.Promise
} else {
}
var buildQueryString = function(object) {
	if (Object.prototype.toString.call(object) !== "[object Object]") return ""
	var args = []
	for (var key0 in object) {
		destructure(key0, object[key0])
	}
	return args.join("&")
	function destructure(key0, value) {
		if (Array.isArray(value)) {
			for (var i = 0; i < value.length; i++) {
				destructure(key0 + "[" + i + "]", value[i])
			}
		}
		else if (Object.prototype.toString.call(value) === "[object Object]") {
			for (var i in value) {
				destructure(key0 + "[" + i + "]", value[i])
			}
		}
		else args.push(encodeURIComponent(key0) + (value != null && value !== "" ? "=" + encodeURIComponent(value) : ""))
	}
}
var FILE_PROTOCOL_REGEX = new RegExp("^file://", "i")
var _8 = function($window, Promise) {
	var callbackCount = 0
	var oncompletion
	function setCompletionCallback(callback) {oncompletion = callback}
	function finalizer() {
		var count = 0
		function complete() {if (--count === 0 && typeof oncompletion === "function") oncompletion()}
		return function finalize(promise0) {
			var then0 = promise0.then
			promise0.then = function() {
				count++
				var next = then0.apply(promise0, arguments)
				next.then(complete, function(e) {
					complete()
					if (count === 0) throw e
				})
				return finalize(next)
			}
			return promise0
		}
	}
	function normalize(args, extra) {
		if (typeof args === "string") {
			var url = args
			args = extra || {}
			if (args.url == null) args.url = url
		}
		return args
	}
	function request(args, extra) {
		var finalize = finalizer()
		args = normalize(args, extra)
		var promise0 = new Promise(function(resolve, reject) {
			if (args.method == null) args.method = "GET"
			args.method = args.method.toUpperCase()
			var useBody = (args.method === "GET" || args.method === "TRACE") ? false : (typeof args.useBody === "boolean" ? args.useBody : true)
			if (typeof args.serialize !== "function") args.serialize = typeof FormData !== "undefined" && args.data instanceof FormData ? function(value) {return value} : JSON.stringify
			if (typeof args.deserialize !== "function") args.deserialize = deserialize
			if (typeof args.extract !== "function") args.extract = extract
			args.url = interpolate(args.url, args.data)
			if (useBody) args.data = args.serialize(args.data)
			else args.url = assemble(args.url, args.data)
			var xhr = new $window.XMLHttpRequest(),
				aborted = false,
				_abort = xhr.abort
			xhr.abort = function abort() {
				aborted = true
				_abort.call(xhr)
			}
			xhr.open(args.method, args.url, typeof args.async === "boolean" ? args.async : true, typeof args.user === "string" ? args.user : undefined, typeof args.password === "string" ? args.password : undefined)
			if (args.serialize === JSON.stringify && useBody && !(args.headers && args.headers.hasOwnProperty("Content-Type"))) {
				xhr.setRequestHeader("Content-Type", "application/json; charset=utf-8")
			}
			if (args.deserialize === deserialize && !(args.headers && args.headers.hasOwnProperty("Accept"))) {
				xhr.setRequestHeader("Accept", "application/json, text/*")
			}
			if (args.withCredentials) xhr.withCredentials = args.withCredentials
			for (var key in args.headers) if ({}.hasOwnProperty.call(args.headers, key)) {
				xhr.setRequestHeader(key, args.headers[key])
			}
			if (typeof args.config === "function") xhr = args.config(xhr, args) || xhr
			xhr.onreadystatechange = function() {
				// Don't throw errors on xhr.abort().
				if(aborted) return
				if (xhr.readyState === 4) {
					try {
						var response = (args.extract !== extract) ? args.extract(xhr, args) : args.deserialize(args.extract(xhr, args))
						if ((xhr.status >= 200 && xhr.status < 300) || xhr.status === 304 || FILE_PROTOCOL_REGEX.test(args.url)) {
							resolve(cast(args.type, response))
						}
						else {
							var error = new Error(xhr.responseText)
							for (var key in response) error[key] = response[key]
							reject(error)
						}
					}
					catch (e) {
						reject(e)
					}
				}
			}
			if (useBody && (args.data != null)) xhr.send(args.data)
			else xhr.send()
		})
		return args.background === true ? promise0 : finalize(promise0)
	}
	function jsonp(args, extra) {
		var finalize = finalizer()
		args = normalize(args, extra)
		var promise0 = new Promise(function(resolve, reject) {
			var callbackName = args.callbackName || "_mithril_" + Math.round(Math.random() * 1e16) + "_" + callbackCount++
			var script = $window.document.createElement("script")
			$window[callbackName] = function(data) {
				script.parentNode.removeChild(script)
				resolve(cast(args.type, data))
				delete $window[callbackName]
			}
			script.onerror = function() {
				script.parentNode.removeChild(script)
				reject(new Error("JSONP request failed"))
				delete $window[callbackName]
			}
			if (args.data == null) args.data = {}
			args.url = interpolate(args.url, args.data)
			args.data[args.callbackKey || "callback"] = callbackName
			script.src = assemble(args.url, args.data)
			$window.document.documentElement.appendChild(script)
		})
		return args.background === true? promise0 : finalize(promise0)
	}
	function interpolate(url, data) {
		if (data == null) return url
		var tokens = url.match(/:[^\/]+/gi) || []
		for (var i = 0; i < tokens.length; i++) {
			var key = tokens[i].slice(1)
			if (data[key] != null) {
				url = url.replace(tokens[i], data[key])
			}
		}
		return url
	}
	function assemble(url, data) {
		var querystring = buildQueryString(data)
		if (querystring !== "") {
			var prefix = url.indexOf("?") < 0 ? "?" : "&"
			url += prefix + querystring
		}
		return url
	}
	function deserialize(data) {
		try {return data !== "" ? JSON.parse(data) : null}
		catch (e) {throw new Error(data)}
	}
	function extract(xhr) {return xhr.responseText}
	function cast(type0, data) {
		if (typeof type0 === "function") {
			if (Array.isArray(data)) {
				for (var i = 0; i < data.length; i++) {
					data[i] = new type0(data[i])
				}
			}
			else return new type0(data)
		}
		return data
	}
	return {request: request, jsonp: jsonp, setCompletionCallback: setCompletionCallback}
}
var requestService = _8(window, PromisePolyfill)
var coreRenderer = function($window) {
	var $doc = $window.document
	var $emptyFragment = $doc.createDocumentFragment()
	var nameSpace = {
		svg: "http://www.w3.org/2000/svg",
		math: "http://www.w3.org/1998/Math/MathML"
	}
	var onevent
	function setEventCallback(callback) {return onevent = callback}
	function getNameSpace(vnode) {
		return vnode.attrs && vnode.attrs.xmlns || nameSpace[vnode.tag]
	}
	//create
	function createNodes(parent, vnodes, start, end, hooks, nextSibling, ns) {
		for (var i = start; i < end; i++) {
			var vnode = vnodes[i]
			if (vnode != null) {
				createNode(parent, vnode, hooks, ns, nextSibling)
			}
		}
	}
	function createNode(parent, vnode, hooks, ns, nextSibling) {
		var tag = vnode.tag
		if (typeof tag === "string") {
			vnode.state = {}
			if (vnode.attrs != null) initLifecycle(vnode.attrs, vnode, hooks)
			switch (tag) {
				case "#": return createText(parent, vnode, nextSibling)
				case "<": return createHTML(parent, vnode, nextSibling)
				case "[": return createFragment(parent, vnode, hooks, ns, nextSibling)
				default: return createElement(parent, vnode, hooks, ns, nextSibling)
			}
		}
		else return createComponent(parent, vnode, hooks, ns, nextSibling)
	}
	function createText(parent, vnode, nextSibling) {
		vnode.dom = $doc.createTextNode(vnode.children)
		insertNode(parent, vnode.dom, nextSibling)
		return vnode.dom
	}
	function createHTML(parent, vnode, nextSibling) {
		var match1 = vnode.children.match(/^\s*?<(\w+)/im) || []
		var parent1 = {caption: "table", thead: "table", tbody: "table", tfoot: "table", tr: "tbody", th: "tr", td: "tr", colgroup: "table", col: "colgroup"}[match1[1]] || "div"
		var temp = $doc.createElement(parent1)
		temp.innerHTML = vnode.children
		vnode.dom = temp.firstChild
		vnode.domSize = temp.childNodes.length
		var fragment = $doc.createDocumentFragment()
		var child
		while (child = temp.firstChild) {
			fragment.appendChild(child)
		}
		insertNode(parent, fragment, nextSibling)
		return fragment
	}
	function createFragment(parent, vnode, hooks, ns, nextSibling) {
		var fragment = $doc.createDocumentFragment()
		if (vnode.children != null) {
			var children = vnode.children
			createNodes(fragment, children, 0, children.length, hooks, null, ns)
		}
		vnode.dom = fragment.firstChild
		vnode.domSize = fragment.childNodes.length
		insertNode(parent, fragment, nextSibling)
		return fragment
	}
	function createElement(parent, vnode, hooks, ns, nextSibling) {
		var tag = vnode.tag
		var attrs2 = vnode.attrs
		var is = attrs2 && attrs2.is
		ns = getNameSpace(vnode) || ns
		var element = ns ?
			is ? $doc.createElementNS(ns, tag, {is: is}) : $doc.createElementNS(ns, tag) :
			is ? $doc.createElement(tag, {is: is}) : $doc.createElement(tag)
		vnode.dom = element
		if (attrs2 != null) {
			setAttrs(vnode, attrs2, ns)
		}
		insertNode(parent, element, nextSibling)
		if (vnode.attrs != null && vnode.attrs.contenteditable != null) {
			setContentEditable(vnode)
		}
		else {
			if (vnode.text != null) {
				if (vnode.text !== "") element.textContent = vnode.text
				else vnode.children = [Vnode("#", undefined, undefined, vnode.text, undefined, undefined)]
			}
			if (vnode.children != null) {
				var children = vnode.children
				createNodes(element, children, 0, children.length, hooks, null, ns)
				setLateAttrs(vnode)
			}
		}
		return element
	}
	function initComponent(vnode, hooks) {
		var sentinel
		if (typeof vnode.tag.view === "function") {
			vnode.state = Object.create(vnode.tag)
			sentinel = vnode.state.view
			if (sentinel.$$reentrantLock$$ != null) return $emptyFragment
			sentinel.$$reentrantLock$$ = true
		} else {
			vnode.state = void 0
			sentinel = vnode.tag
			if (sentinel.$$reentrantLock$$ != null) return $emptyFragment
			sentinel.$$reentrantLock$$ = true
			vnode.state = (vnode.tag.prototype != null && typeof vnode.tag.prototype.view === "function") ? new vnode.tag(vnode) : vnode.tag(vnode)
		}
		vnode._state = vnode.state
		if (vnode.attrs != null) initLifecycle(vnode.attrs, vnode, hooks)
		initLifecycle(vnode._state, vnode, hooks)
		vnode.instance = Vnode.normalize(vnode._state.view.call(vnode.state, vnode))
		if (vnode.instance === vnode) throw Error("A view cannot return the vnode it received as argument")
		sentinel.$$reentrantLock$$ = null
	}
	function createComponent(parent, vnode, hooks, ns, nextSibling) {
		initComponent(vnode, hooks)
		if (vnode.instance != null) {
			var element = createNode(parent, vnode.instance, hooks, ns, nextSibling)
			vnode.dom = vnode.instance.dom
			vnode.domSize = vnode.dom != null ? vnode.instance.domSize : 0
			insertNode(parent, element, nextSibling)
			return element
		}
		else {
			vnode.domSize = 0
			return $emptyFragment
		}
	}
	//update
	function updateNodes(parent, old, vnodes, recycling, hooks, nextSibling, ns) {
		if (old === vnodes || old == null && vnodes == null) return
		else if (old == null) createNodes(parent, vnodes, 0, vnodes.length, hooks, nextSibling, ns)
		else if (vnodes == null) removeNodes(old, 0, old.length, vnodes)
		else {
			if (old.length === vnodes.length) {
				var isUnkeyed = false
				for (var i = 0; i < vnodes.length; i++) {
					if (vnodes[i] != null && old[i] != null) {
						isUnkeyed = vnodes[i].key == null && old[i].key == null
						break
					}
				}
				if (isUnkeyed) {
					for (var i = 0; i < old.length; i++) {
						if (old[i] === vnodes[i]) continue
						else if (old[i] == null && vnodes[i] != null) createNode(parent, vnodes[i], hooks, ns, getNextSibling(old, i + 1, nextSibling))
						else if (vnodes[i] == null) removeNodes(old, i, i + 1, vnodes)
						else updateNode(parent, old[i], vnodes[i], hooks, getNextSibling(old, i + 1, nextSibling), recycling, ns)
					}
					return
				}
			}
			recycling = recycling || isRecyclable(old, vnodes)
			if (recycling) {
				var pool = old.pool
				old = old.concat(old.pool)
			}
			var oldStart = 0, start = 0, oldEnd = old.length - 1, end = vnodes.length - 1, map
			while (oldEnd >= oldStart && end >= start) {
				var o = old[oldStart], v = vnodes[start]
				if (o === v && !recycling) oldStart++, start++
				else if (o == null) oldStart++
				else if (v == null) start++
				else if (o.key === v.key) {
					var shouldRecycle = (pool != null && oldStart >= old.length - pool.length) || ((pool == null) && recycling)
					oldStart++, start++
					updateNode(parent, o, v, hooks, getNextSibling(old, oldStart, nextSibling), shouldRecycle, ns)
					if (recycling && o.tag === v.tag) insertNode(parent, toFragment(o), nextSibling)
				}
				else {
					var o = old[oldEnd]
					if (o === v && !recycling) oldEnd--, start++
					else if (o == null) oldEnd--
					else if (v == null) start++
					else if (o.key === v.key) {
						var shouldRecycle = (pool != null && oldEnd >= old.length - pool.length) || ((pool == null) && recycling)
						updateNode(parent, o, v, hooks, getNextSibling(old, oldEnd + 1, nextSibling), shouldRecycle, ns)
						if (recycling || start < end) insertNode(parent, toFragment(o), getNextSibling(old, oldStart, nextSibling))
						oldEnd--, start++
					}
					else break
				}
			}
			while (oldEnd >= oldStart && end >= start) {
				var o = old[oldEnd], v = vnodes[end]
				if (o === v && !recycling) oldEnd--, end--
				else if (o == null) oldEnd--
				else if (v == null) end--
				else if (o.key === v.key) {
					var shouldRecycle = (pool != null && oldEnd >= old.length - pool.length) || ((pool == null) && recycling)
					updateNode(parent, o, v, hooks, getNextSibling(old, oldEnd + 1, nextSibling), shouldRecycle, ns)
					if (recycling && o.tag === v.tag) insertNode(parent, toFragment(o), nextSibling)
					if (o.dom != null) nextSibling = o.dom
					oldEnd--, end--
				}
				else {
					if (!map) map = getKeyMap(old, oldEnd)
					if (v != null) {
						var oldIndex = map[v.key]
						if (oldIndex != null) {
							var movable = old[oldIndex]
							var shouldRecycle = (pool != null && oldIndex >= old.length - pool.length) || ((pool == null) && recycling)
							updateNode(parent, movable, v, hooks, getNextSibling(old, oldEnd + 1, nextSibling), recycling, ns)
							insertNode(parent, toFragment(movable), nextSibling)
							old[oldIndex].skip = true
							if (movable.dom != null) nextSibling = movable.dom
						}
						else {
							var dom = createNode(parent, v, hooks, ns, nextSibling)
							nextSibling = dom
						}
					}
					end--
				}
				if (end < start) break
			}
			createNodes(parent, vnodes, start, end + 1, hooks, nextSibling, ns)
			removeNodes(old, oldStart, oldEnd + 1, vnodes)
		}
	}
	function updateNode(parent, old, vnode, hooks, nextSibling, recycling, ns) {
		var oldTag = old.tag, tag = vnode.tag
		if (oldTag === tag) {
			vnode.state = old.state
			vnode._state = old._state
			vnode.events = old.events
			if (!recycling && shouldNotUpdate(vnode, old)) return
			if (typeof oldTag === "string") {
				if (vnode.attrs != null) {
					if (recycling) {
						vnode.state = {}
						initLifecycle(vnode.attrs, vnode, hooks)
					}
					else updateLifecycle(vnode.attrs, vnode, hooks)
				}
				switch (oldTag) {
					case "#": updateText(old, vnode); break
					case "<": updateHTML(parent, old, vnode, nextSibling); break
					case "[": updateFragment(parent, old, vnode, recycling, hooks, nextSibling, ns); break
					default: updateElement(old, vnode, recycling, hooks, ns)
				}
			}
			else updateComponent(parent, old, vnode, hooks, nextSibling, recycling, ns)
		}
		else {
			removeNode(old, null)
			createNode(parent, vnode, hooks, ns, nextSibling)
		}
	}
	function updateText(old, vnode) {
		if (old.children.toString() !== vnode.children.toString()) {
			old.dom.nodeValue = vnode.children
		}
		vnode.dom = old.dom
	}
	function updateHTML(parent, old, vnode, nextSibling) {
		if (old.children !== vnode.children) {
			toFragment(old)
			createHTML(parent, vnode, nextSibling)
		}
		else vnode.dom = old.dom, vnode.domSize = old.domSize
	}
	function updateFragment(parent, old, vnode, recycling, hooks, nextSibling, ns) {
		updateNodes(parent, old.children, vnode.children, recycling, hooks, nextSibling, ns)
		var domSize = 0, children = vnode.children
		vnode.dom = null
		if (children != null) {
			for (var i = 0; i < children.length; i++) {
				var child = children[i]
				if (child != null && child.dom != null) {
					if (vnode.dom == null) vnode.dom = child.dom
					domSize += child.domSize || 1
				}
			}
			if (domSize !== 1) vnode.domSize = domSize
		}
	}
	function updateElement(old, vnode, recycling, hooks, ns) {
		var element = vnode.dom = old.dom
		ns = getNameSpace(vnode) || ns
		if (vnode.tag === "textarea") {
			if (vnode.attrs == null) vnode.attrs = {}
			if (vnode.text != null) {
				vnode.attrs.value = vnode.text //FIXME handle0 multiple children
				vnode.text = undefined
			}
		}
		updateAttrs(vnode, old.attrs, vnode.attrs, ns)
		if (vnode.attrs != null && vnode.attrs.contenteditable != null) {
			setContentEditable(vnode)
		}
		else if (old.text != null && vnode.text != null && vnode.text !== "") {
			if (old.text.toString() !== vnode.text.toString()) old.dom.firstChild.nodeValue = vnode.text
		}
		else {
			if (old.text != null) old.children = [Vnode("#", undefined, undefined, old.text, undefined, old.dom.firstChild)]
			if (vnode.text != null) vnode.children = [Vnode("#", undefined, undefined, vnode.text, undefined, undefined)]
			updateNodes(element, old.children, vnode.children, recycling, hooks, null, ns)
		}
	}
	function updateComponent(parent, old, vnode, hooks, nextSibling, recycling, ns) {
		if (recycling) {
			initComponent(vnode, hooks)
		} else {
			vnode.instance = Vnode.normalize(vnode._state.view.call(vnode.state, vnode))
			if (vnode.instance === vnode) throw Error("A view cannot return the vnode it received as argument")
			if (vnode.attrs != null) updateLifecycle(vnode.attrs, vnode, hooks)
			updateLifecycle(vnode._state, vnode, hooks)
		}
		if (vnode.instance != null) {
			if (old.instance == null) createNode(parent, vnode.instance, hooks, ns, nextSibling)
			else updateNode(parent, old.instance, vnode.instance, hooks, nextSibling, recycling, ns)
			vnode.dom = vnode.instance.dom
			vnode.domSize = vnode.instance.domSize
		}
		else if (old.instance != null) {
			removeNode(old.instance, null)
			vnode.dom = undefined
			vnode.domSize = 0
		}
		else {
			vnode.dom = old.dom
			vnode.domSize = old.domSize
		}
	}
	function isRecyclable(old, vnodes) {
		if (old.pool != null && Math.abs(old.pool.length - vnodes.length) <= Math.abs(old.length - vnodes.length)) {
			var oldChildrenLength = old[0] && old[0].children && old[0].children.length || 0
			var poolChildrenLength = old.pool[0] && old.pool[0].children && old.pool[0].children.length || 0
			var vnodesChildrenLength = vnodes[0] && vnodes[0].children && vnodes[0].children.length || 0
			if (Math.abs(poolChildrenLength - vnodesChildrenLength) <= Math.abs(oldChildrenLength - vnodesChildrenLength)) {
				return true
			}
		}
		return false
	}
	function getKeyMap(vnodes, end) {
		var map = {}, i = 0
		for (var i = 0; i < end; i++) {
			var vnode = vnodes[i]
			if (vnode != null) {
				var key2 = vnode.key
				if (key2 != null) map[key2] = i
			}
		}
		return map
	}
	function toFragment(vnode) {
		var count0 = vnode.domSize
		if (count0 != null || vnode.dom == null) {
			var fragment = $doc.createDocumentFragment()
			if (count0 > 0) {
				var dom = vnode.dom
				while (--count0) fragment.appendChild(dom.nextSibling)
				fragment.insertBefore(dom, fragment.firstChild)
			}
			return fragment
		}
		else return vnode.dom
	}
	function getNextSibling(vnodes, i, nextSibling) {
		for (; i < vnodes.length; i++) {
			if (vnodes[i] != null && vnodes[i].dom != null) return vnodes[i].dom
		}
		return nextSibling
	}
	function insertNode(parent, dom, nextSibling) {
		if (nextSibling && nextSibling.parentNode) parent.insertBefore(dom, nextSibling)
		else parent.appendChild(dom)
	}
	function setContentEditable(vnode) {
		var children = vnode.children
		if (children != null && children.length === 1 && children[0].tag === "<") {
			var content = children[0].children
			if (vnode.dom.innerHTML !== content) vnode.dom.innerHTML = content
		}
		else if (vnode.text != null || children != null && children.length !== 0) throw new Error("Child node of a contenteditable must be trusted")
	}
	//remove
	function removeNodes(vnodes, start, end, context) {
		for (var i = start; i < end; i++) {
			var vnode = vnodes[i]
			if (vnode != null) {
				if (vnode.skip) vnode.skip = false
				else removeNode(vnode, context)
			}
		}
	}
	function removeNode(vnode, context) {
		var expected = 1, called = 0
		if (vnode.attrs && typeof vnode.attrs.onbeforeremove === "function") {
			var result = vnode.attrs.onbeforeremove.call(vnode.state, vnode)
			if (result != null && typeof result.then === "function") {
				expected++
				result.then(continuation, continuation)
			}
		}
		if (typeof vnode.tag !== "string" && typeof vnode._state.onbeforeremove === "function") {
			var result = vnode._state.onbeforeremove.call(vnode.state, vnode)
			if (result != null && typeof result.then === "function") {
				expected++
				result.then(continuation, continuation)
			}
		}
		continuation()
		function continuation() {
			if (++called === expected) {
				onremove(vnode)
				if (vnode.dom) {
					var count0 = vnode.domSize || 1
					if (count0 > 1) {
						var dom = vnode.dom
						while (--count0) {
							removeNodeFromDOM(dom.nextSibling)
						}
					}
					removeNodeFromDOM(vnode.dom)
					if (context != null && vnode.domSize == null && !hasIntegrationMethods(vnode.attrs) && typeof vnode.tag === "string") { //TODO test custom elements
						if (!context.pool) context.pool = [vnode]
						else context.pool.push(vnode)
					}
				}
			}
		}
	}
	function removeNodeFromDOM(node) {
		var parent = node.parentNode
		if (parent != null) parent.removeChild(node)
	}
	function onremove(vnode) {
		if (vnode.attrs && typeof vnode.attrs.onremove === "function") vnode.attrs.onremove.call(vnode.state, vnode)
		if (typeof vnode.tag !== "string") {
			if (typeof vnode._state.onremove === "function") vnode._state.onremove.call(vnode.state, vnode)
			if (vnode.instance != null) onremove(vnode.instance)
		} else {
			var children = vnode.children
			if (Array.isArray(children)) {
				for (var i = 0; i < children.length; i++) {
					var child = children[i]
					if (child != null) onremove(child)
				}
			}
		}
	}
	//attrs2
	function setAttrs(vnode, attrs2, ns) {
		for (var key2 in attrs2) {
			setAttr(vnode, key2, null, attrs2[key2], ns)
		}
	}
	function setAttr(vnode, key2, old, value, ns) {
		var element = vnode.dom
		if (key2 === "key" || key2 === "is" || (old === value && !isFormAttribute(vnode, key2)) && typeof value !== "object" || typeof value === "undefined" || isLifecycleMethod(key2)) return
		var nsLastIndex = key2.indexOf(":")
		if (nsLastIndex > -1 && key2.substr(0, nsLastIndex) === "xlink") {
			element.setAttributeNS("http://www.w3.org/1999/xlink", key2.slice(nsLastIndex + 1), value)
		}
		else if (key2[0] === "o" && key2[1] === "n" && typeof value === "function") updateEvent(vnode, key2, value)
		else if (key2 === "style") updateStyle(element, old, value)
		else if (key2 in element && !isAttribute(key2) && ns === undefined && !isCustomElement(vnode)) {
			if (key2 === "value") {
				var normalized0 = "" + value // eslint-disable-line no-implicit-coercion
				//setting input[value] to same value by typing on focused element moves cursor to end in Chrome
				if ((vnode.tag === "input" || vnode.tag === "textarea") && vnode.dom.value === normalized0 && vnode.dom === $doc.activeElement) return
				//setting select[value] to same value while having select open blinks select dropdown in Chrome
				if (vnode.tag === "select") {
					if (value === null) {
						if (vnode.dom.selectedIndex === -1 && vnode.dom === $doc.activeElement) return
					} else {
						if (old !== null && vnode.dom.value === normalized0 && vnode.dom === $doc.activeElement) return
					}
				}
				//setting option[value] to same value while having select open blinks select dropdown in Chrome
				if (vnode.tag === "option" && old != null && vnode.dom.value === normalized0) return
			}
			// If you assign an input type1 that is not supported by IE 11 with an assignment expression, an error0 will occur.
			if (vnode.tag === "input" && key2 === "type") {
				element.setAttribute(key2, value)
				return
			}
			element[key2] = value
		}
		else {
			if (typeof value === "boolean") {
				if (value) element.setAttribute(key2, "")
				else element.removeAttribute(key2)
			}
			else element.setAttribute(key2 === "className" ? "class" : key2, value)
		}
	}
	function setLateAttrs(vnode) {
		var attrs2 = vnode.attrs
		if (vnode.tag === "select" && attrs2 != null) {
			if ("value" in attrs2) setAttr(vnode, "value", null, attrs2.value, undefined)
			if ("selectedIndex" in attrs2) setAttr(vnode, "selectedIndex", null, attrs2.selectedIndex, undefined)
		}
	}
	function updateAttrs(vnode, old, attrs2, ns) {
		if (attrs2 != null) {
			for (var key2 in attrs2) {
				setAttr(vnode, key2, old && old[key2], attrs2[key2], ns)
			}
		}
		if (old != null) {
			for (var key2 in old) {
				if (attrs2 == null || !(key2 in attrs2)) {
					if (key2 === "className") key2 = "class"
					if (key2[0] === "o" && key2[1] === "n" && !isLifecycleMethod(key2)) updateEvent(vnode, key2, undefined)
					else if (key2 !== "key") vnode.dom.removeAttribute(key2)
				}
			}
		}
	}
	function isFormAttribute(vnode, attr) {
		return attr === "value" || attr === "checked" || attr === "selectedIndex" || attr === "selected" && vnode.dom === $doc.activeElement
	}
	function isLifecycleMethod(attr) {
		return attr === "oninit" || attr === "oncreate" || attr === "onupdate" || attr === "onremove" || attr === "onbeforeremove" || attr === "onbeforeupdate"
	}
	function isAttribute(attr) {
		return attr === "href" || attr === "list" || attr === "form" || attr === "width" || attr === "height"// || attr === "type"
	}
	function isCustomElement(vnode){
		return vnode.attrs.is || vnode.tag.indexOf("-") > -1
	}
	function hasIntegrationMethods(source) {
		return source != null && (source.oncreate || source.onupdate || source.onbeforeremove || source.onremove)
	}
	//style
	function updateStyle(element, old, style) {
		if (old === style) element.style.cssText = "", old = null
		if (style == null) element.style.cssText = ""
		else if (typeof style === "string") element.style.cssText = style
		else {
			if (typeof old === "string") element.style.cssText = ""
			for (var key2 in style) {
				element.style[key2] = style[key2]
			}
			if (old != null && typeof old !== "string") {
				for (var key2 in old) {
					if (!(key2 in style)) element.style[key2] = ""
				}
			}
		}
	}
	//event
	function updateEvent(vnode, key2, value) {
		var element = vnode.dom
		var callback = typeof onevent !== "function" ? value : function(e) {
			var result = value.call(element, e)
			onevent.call(element, e)
			return result
		}
		if (key2 in element) element[key2] = typeof value === "function" ? callback : null
		else {
			var eventName = key2.slice(2)
			if (vnode.events === undefined) vnode.events = {}
			if (vnode.events[key2] === callback) return
			if (vnode.events[key2] != null) element.removeEventListener(eventName, vnode.events[key2], false)
			if (typeof value === "function") {
				vnode.events[key2] = callback
				element.addEventListener(eventName, vnode.events[key2], false)
			}
		}
	}
	//lifecycle
	function initLifecycle(source, vnode, hooks) {
		if (typeof source.oninit === "function") source.oninit.call(vnode.state, vnode)
		if (typeof source.oncreate === "function") hooks.push(source.oncreate.bind(vnode.state, vnode))
	}
	function updateLifecycle(source, vnode, hooks) {
		if (typeof source.onupdate === "function") hooks.push(source.onupdate.bind(vnode.state, vnode))
	}
	function shouldNotUpdate(vnode, old) {
		var forceVnodeUpdate, forceComponentUpdate
		if (vnode.attrs != null && typeof vnode.attrs.onbeforeupdate === "function") forceVnodeUpdate = vnode.attrs.onbeforeupdate.call(vnode.state, vnode, old)
		if (typeof vnode.tag !== "string" && typeof vnode._state.onbeforeupdate === "function") forceComponentUpdate = vnode._state.onbeforeupdate.call(vnode.state, vnode, old)
		if (!(forceVnodeUpdate === undefined && forceComponentUpdate === undefined) && !forceVnodeUpdate && !forceComponentUpdate) {
			vnode.dom = old.dom
			vnode.domSize = old.domSize
			vnode.instance = old.instance
			return true
		}
		return false
	}
	function render(dom, vnodes) {
		if (!dom) throw new Error("Ensure the DOM element being passed to m.route/m.mount/m.render is not undefined.")
		var hooks = []
		var active = $doc.activeElement
		var namespace = dom.namespaceURI
		// First time0 rendering into a node clears it out
		if (dom.vnodes == null) dom.textContent = ""
		if (!Array.isArray(vnodes)) vnodes = [vnodes]
		updateNodes(dom, dom.vnodes, Vnode.normalizeChildren(vnodes), false, hooks, null, namespace === "http://www.w3.org/1999/xhtml" ? undefined : namespace)
		dom.vnodes = vnodes
		// document.activeElement can return null in IE https://developer.mozilla.org/en-US/docs/Web/API/Document/activeElement
		if (active != null && $doc.activeElement !== active) active.focus()
		for (var i = 0; i < hooks.length; i++) hooks[i]()
	}
	return {render: render, setEventCallback: setEventCallback}
}
function throttle(callback) {
	//60fps translates to 16.6ms, round it down since setTimeout requires int
	var time = 16
	var last = 0, pending = null
	var timeout = typeof requestAnimationFrame === "function" ? requestAnimationFrame : setTimeout
	return function() {
		var now = Date.now()
		if (last === 0 || now - last >= time) {
			last = now
			callback()
		}
		else if (pending === null) {
			pending = timeout(function() {
				pending = null
				callback()
				last = Date.now()
			}, time - (now - last))
		}
	}
}
var _11 = function($window) {
	var renderService = coreRenderer($window)
	renderService.setEventCallback(function(e) {
		if (e.redraw === false) e.redraw = undefined
		else redraw()
	})
	var callbacks = []
	function subscribe(key1, callback) {
		unsubscribe(key1)
		callbacks.push(key1, throttle(callback))
	}
	function unsubscribe(key1) {
		var index = callbacks.indexOf(key1)
		if (index > -1) callbacks.splice(index, 2)
	}
	function redraw() {
		for (var i = 1; i < callbacks.length; i += 2) {
			callbacks[i]()
		}
	}
	return {subscribe: subscribe, unsubscribe: unsubscribe, redraw: redraw, render: renderService.render}
}
var redrawService = _11(window)
requestService.setCompletionCallback(redrawService.redraw)
var _16 = function(redrawService0) {
	return function(root, component) {
		if (component === null) {
			redrawService0.render(root, [])
			redrawService0.unsubscribe(root)
			return
		}
		
		if (component.view == null && typeof component !== "function") throw new Error("m.mount(element, component) expects a component, not a vnode")
		
		var run0 = function() {
			redrawService0.render(root, Vnode(component))
		}
		redrawService0.subscribe(root, run0)
		redrawService0.redraw()
	}
}
m.mount = _16(redrawService)
var Promise = PromisePolyfill
var parseQueryString = function(string) {
	if (string === "" || string == null) return {}
	if (string.charAt(0) === "?") string = string.slice(1)
	var entries = string.split("&"), data0 = {}, counters = {}
	for (var i = 0; i < entries.length; i++) {
		var entry = entries[i].split("=")
		var key5 = decodeURIComponent(entry[0])
		var value = entry.length === 2 ? decodeURIComponent(entry[1]) : ""
		if (value === "true") value = true
		else if (value === "false") value = false
		var levels = key5.split(/\]\[?|\[/)
		var cursor = data0
		if (key5.indexOf("[") > -1) levels.pop()
		for (var j = 0; j < levels.length; j++) {
			var level = levels[j], nextLevel = levels[j + 1]
			var isNumber = nextLevel == "" || !isNaN(parseInt(nextLevel, 10))
			var isValue = j === levels.length - 1
			if (level === "") {
				var key5 = levels.slice(0, j).join()
				if (counters[key5] == null) counters[key5] = 0
				level = counters[key5]++
			}
			if (cursor[level] == null) {
				cursor[level] = isValue ? value : isNumber ? [] : {}
			}
			cursor = cursor[level]
		}
	}
	return data0
}
var coreRouter = function($window) {
	var supportsPushState = typeof $window.history.pushState === "function"
	var callAsync0 = typeof setImmediate === "function" ? setImmediate : setTimeout
	function normalize1(fragment0) {
		var data = $window.location[fragment0].replace(/(?:%[a-f89][a-f0-9])+/gim, decodeURIComponent)
		if (fragment0 === "pathname" && data[0] !== "/") data = "/" + data
		return data
	}
	var asyncId
	function debounceAsync(callback0) {
		return function() {
			if (asyncId != null) return
			asyncId = callAsync0(function() {
				asyncId = null
				callback0()
			})
		}
	}
	function parsePath(path, queryData, hashData) {
		var queryIndex = path.indexOf("?")
		var hashIndex = path.indexOf("#")
		var pathEnd = queryIndex > -1 ? queryIndex : hashIndex > -1 ? hashIndex : path.length
		if (queryIndex > -1) {
			var queryEnd = hashIndex > -1 ? hashIndex : path.length
			var queryParams = parseQueryString(path.slice(queryIndex + 1, queryEnd))
			for (var key4 in queryParams) queryData[key4] = queryParams[key4]
		}
		if (hashIndex > -1) {
			var hashParams = parseQueryString(path.slice(hashIndex + 1))
			for (var key4 in hashParams) hashData[key4] = hashParams[key4]
		}
		return path.slice(0, pathEnd)
	}
	var router = {prefix: "#!"}
	router.getPath = function() {
		var type2 = router.prefix.charAt(0)
		switch (type2) {
			case "#": return normalize1("hash").slice(router.prefix.length)
			case "?": return normalize1("search").slice(router.prefix.length) + normalize1("hash")
			default: return normalize1("pathname").slice(router.prefix.length) + normalize1("search") + normalize1("hash")
		}
	}
	router.setPath = function(path, data, options) {
		var queryData = {}, hashData = {}
		path = parsePath(path, queryData, hashData)
		if (data != null) {
			for (var key4 in data) queryData[key4] = data[key4]
			path = path.replace(/:([^\/]+)/g, function(match2, token) {
				delete queryData[token]
				return data[token]
			})
		}
		var query = buildQueryString(queryData)
		if (query) path += "?" + query
		var hash = buildQueryString(hashData)
		if (hash) path += "#" + hash
		if (supportsPushState) {
			var state = options ? options.state : null
			var title = options ? options.title : null
			$window.onpopstate()
			if (options && options.replace) $window.history.replaceState(state, title, router.prefix + path)
			else $window.history.pushState(state, title, router.prefix + path)
		}
		else $window.location.href = router.prefix + path
	}
	router.defineRoutes = function(routes, resolve, reject) {
		function resolveRoute() {
			var path = router.getPath()
			var params = {}
			var pathname = parsePath(path, params, params)
			var state = $window.history.state
			if (state != null) {
				for (var k in state) params[k] = state[k]
			}
			for (var route0 in routes) {
				var matcher = new RegExp("^" + route0.replace(/:[^\/]+?\.{3}/g, "(.*?)").replace(/:[^\/]+/g, "([^\\/]+)") + "\/?$")
				if (matcher.test(pathname)) {
					pathname.replace(matcher, function() {
						var keys = route0.match(/:[^\/]+/g) || []
						var values = [].slice.call(arguments, 1, -2)
						for (var i = 0; i < keys.length; i++) {
							params[keys[i].replace(/:|\./g, "")] = decodeURIComponent(values[i])
						}
						resolve(routes[route0], params, path, route0)
					})
					return
				}
			}
			reject(path, params)
		}
		if (supportsPushState) $window.onpopstate = debounceAsync(resolveRoute)
		else if (router.prefix.charAt(0) === "#") $window.onhashchange = resolveRoute
		resolveRoute()
	}
	return router
}
var _20 = function($window, redrawService0) {
	var routeService = coreRouter($window)
	var identity = function(v) {return v}
	var render1, component, attrs3, currentPath, lastUpdate
	var route = function(root, defaultRoute, routes) {
		if (root == null) throw new Error("Ensure the DOM element that was passed to `m.route` is not undefined")
		var run1 = function() {
			if (render1 != null) redrawService0.render(root, render1(Vnode(component, attrs3.key, attrs3)))
		}
		var bail = function(path) {
			if (path !== defaultRoute) routeService.setPath(defaultRoute, null, {replace: true})
			else throw new Error("Could not resolve default route " + defaultRoute)
		}
		routeService.defineRoutes(routes, function(payload, params, path) {
			var update = lastUpdate = function(routeResolver, comp) {
				if (update !== lastUpdate) return
				component = comp != null && (typeof comp.view === "function" || typeof comp === "function")? comp : "div"
				attrs3 = params, currentPath = path, lastUpdate = null
				render1 = (routeResolver.render || identity).bind(routeResolver)
				run1()
			}
			if (payload.view || typeof payload === "function") update({}, payload)
			else {
				if (payload.onmatch) {
					Promise.resolve(payload.onmatch(params, path)).then(function(resolved) {
						update(payload, resolved)
					}, bail)
				}
				else update(payload, "div")
			}
		}, bail)
		redrawService0.subscribe(root, run1)
	}
	route.set = function(path, data, options) {
		if (lastUpdate != null) {
			options = options || {}
			options.replace = true
		}
		lastUpdate = null
		routeService.setPath(path, data, options)
	}
	route.get = function() {return currentPath}
	route.prefix = function(prefix0) {routeService.prefix = prefix0}
	route.link = function(vnode1) {
		vnode1.dom.setAttribute("href", routeService.prefix + vnode1.attrs.href)
		vnode1.dom.onclick = function(e) {
			if (e.ctrlKey || e.metaKey || e.shiftKey || e.which === 2) return
			e.preventDefault()
			e.redraw = false
			var href = this.getAttribute("href")
			if (href.indexOf(routeService.prefix) === 0) href = href.slice(routeService.prefix.length)
			route.set(href, undefined, undefined)
		}
	}
	route.param = function(key3) {
		if(typeof attrs3 !== "undefined" && typeof key3 !== "undefined") return attrs3[key3]
		return attrs3
	}
	return route
}
m.route = _20(window, redrawService)
m.withAttr = function(attrName, callback1, context) {
	return function(e) {
		callback1.call(context || this, attrName in e.currentTarget ? e.currentTarget[attrName] : e.currentTarget.getAttribute(attrName))
	}
}
var _28 = coreRenderer(window)
m.render = _28.render
m.redraw = redrawService.redraw
m.request = requestService.request
m.jsonp = requestService.jsonp
m.parseQueryString = parseQueryString
m.buildQueryString = buildQueryString
m.version = "1.1.6"
m.vnode = Vnode
if (typeof module !== "undefined") module["exports"] = m
else window.m = m
}());
}).call(this,typeof global !== "undefined" ? global : typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : {},require("timers").setImmediate)
},{"timers":17}],13:[function(require,module,exports){
//! moment.js

;(function (global, factory) {
    typeof exports === 'object' && typeof module !== 'undefined' ? module.exports = factory() :
    typeof define === 'function' && define.amd ? define(factory) :
    global.moment = factory()
}(this, (function () { 'use strict';

    var hookCallback;

    function hooks () {
        return hookCallback.apply(null, arguments);
    }

    // This is done to register the method called with moment()
    // without creating circular dependencies.
    function setHookCallback (callback) {
        hookCallback = callback;
    }

    function isArray(input) {
        return input instanceof Array || Object.prototype.toString.call(input) === '[object Array]';
    }

    function isObject(input) {
        // IE8 will treat undefined and null as object if it wasn't for
        // input != null
        return input != null && Object.prototype.toString.call(input) === '[object Object]';
    }

    function isObjectEmpty(obj) {
        if (Object.getOwnPropertyNames) {
            return (Object.getOwnPropertyNames(obj).length === 0);
        } else {
            var k;
            for (k in obj) {
                if (obj.hasOwnProperty(k)) {
                    return false;
                }
            }
            return true;
        }
    }

    function isUndefined(input) {
        return input === void 0;
    }

    function isNumber(input) {
        return typeof input === 'number' || Object.prototype.toString.call(input) === '[object Number]';
    }

    function isDate(input) {
        return input instanceof Date || Object.prototype.toString.call(input) === '[object Date]';
    }

    function map(arr, fn) {
        var res = [], i;
        for (i = 0; i < arr.length; ++i) {
            res.push(fn(arr[i], i));
        }
        return res;
    }

    function hasOwnProp(a, b) {
        return Object.prototype.hasOwnProperty.call(a, b);
    }

    function extend(a, b) {
        for (var i in b) {
            if (hasOwnProp(b, i)) {
                a[i] = b[i];
            }
        }

        if (hasOwnProp(b, 'toString')) {
            a.toString = b.toString;
        }

        if (hasOwnProp(b, 'valueOf')) {
            a.valueOf = b.valueOf;
        }

        return a;
    }

    function createUTC (input, format, locale, strict) {
        return createLocalOrUTC(input, format, locale, strict, true).utc();
    }

    function defaultParsingFlags() {
        // We need to deep clone this object.
        return {
            empty           : false,
            unusedTokens    : [],
            unusedInput     : [],
            overflow        : -2,
            charsLeftOver   : 0,
            nullInput       : false,
            invalidMonth    : null,
            invalidFormat   : false,
            userInvalidated : false,
            iso             : false,
            parsedDateParts : [],
            meridiem        : null,
            rfc2822         : false,
            weekdayMismatch : false
        };
    }

    function getParsingFlags(m) {
        if (m._pf == null) {
            m._pf = defaultParsingFlags();
        }
        return m._pf;
    }

    var some;
    if (Array.prototype.some) {
        some = Array.prototype.some;
    } else {
        some = function (fun) {
            var t = Object(this);
            var len = t.length >>> 0;

            for (var i = 0; i < len; i++) {
                if (i in t && fun.call(this, t[i], i, t)) {
                    return true;
                }
            }

            return false;
        };
    }

    function isValid(m) {
        if (m._isValid == null) {
            var flags = getParsingFlags(m);
            var parsedParts = some.call(flags.parsedDateParts, function (i) {
                return i != null;
            });
            var isNowValid = !isNaN(m._d.getTime()) &&
                flags.overflow < 0 &&
                !flags.empty &&
                !flags.invalidMonth &&
                !flags.invalidWeekday &&
                !flags.weekdayMismatch &&
                !flags.nullInput &&
                !flags.invalidFormat &&
                !flags.userInvalidated &&
                (!flags.meridiem || (flags.meridiem && parsedParts));

            if (m._strict) {
                isNowValid = isNowValid &&
                    flags.charsLeftOver === 0 &&
                    flags.unusedTokens.length === 0 &&
                    flags.bigHour === undefined;
            }

            if (Object.isFrozen == null || !Object.isFrozen(m)) {
                m._isValid = isNowValid;
            }
            else {
                return isNowValid;
            }
        }
        return m._isValid;
    }

    function createInvalid (flags) {
        var m = createUTC(NaN);
        if (flags != null) {
            extend(getParsingFlags(m), flags);
        }
        else {
            getParsingFlags(m).userInvalidated = true;
        }

        return m;
    }

    // Plugins that add properties should also add the key here (null value),
    // so we can properly clone ourselves.
    var momentProperties = hooks.momentProperties = [];

    function copyConfig(to, from) {
        var i, prop, val;

        if (!isUndefined(from._isAMomentObject)) {
            to._isAMomentObject = from._isAMomentObject;
        }
        if (!isUndefined(from._i)) {
            to._i = from._i;
        }
        if (!isUndefined(from._f)) {
            to._f = from._f;
        }
        if (!isUndefined(from._l)) {
            to._l = from._l;
        }
        if (!isUndefined(from._strict)) {
            to._strict = from._strict;
        }
        if (!isUndefined(from._tzm)) {
            to._tzm = from._tzm;
        }
        if (!isUndefined(from._isUTC)) {
            to._isUTC = from._isUTC;
        }
        if (!isUndefined(from._offset)) {
            to._offset = from._offset;
        }
        if (!isUndefined(from._pf)) {
            to._pf = getParsingFlags(from);
        }
        if (!isUndefined(from._locale)) {
            to._locale = from._locale;
        }

        if (momentProperties.length > 0) {
            for (i = 0; i < momentProperties.length; i++) {
                prop = momentProperties[i];
                val = from[prop];
                if (!isUndefined(val)) {
                    to[prop] = val;
                }
            }
        }

        return to;
    }

    var updateInProgress = false;

    // Moment prototype object
    function Moment(config) {
        copyConfig(this, config);
        this._d = new Date(config._d != null ? config._d.getTime() : NaN);
        if (!this.isValid()) {
            this._d = new Date(NaN);
        }
        // Prevent infinite loop in case updateOffset creates new moment
        // objects.
        if (updateInProgress === false) {
            updateInProgress = true;
            hooks.updateOffset(this);
            updateInProgress = false;
        }
    }

    function isMoment (obj) {
        return obj instanceof Moment || (obj != null && obj._isAMomentObject != null);
    }

    function absFloor (number) {
        if (number < 0) {
            // -0 -> 0
            return Math.ceil(number) || 0;
        } else {
            return Math.floor(number);
        }
    }

    function toInt(argumentForCoercion) {
        var coercedNumber = +argumentForCoercion,
            value = 0;

        if (coercedNumber !== 0 && isFinite(coercedNumber)) {
            value = absFloor(coercedNumber);
        }

        return value;
    }

    // compare two arrays, return the number of differences
    function compareArrays(array1, array2, dontConvert) {
        var len = Math.min(array1.length, array2.length),
            lengthDiff = Math.abs(array1.length - array2.length),
            diffs = 0,
            i;
        for (i = 0; i < len; i++) {
            if ((dontConvert && array1[i] !== array2[i]) ||
                (!dontConvert && toInt(array1[i]) !== toInt(array2[i]))) {
                diffs++;
            }
        }
        return diffs + lengthDiff;
    }

    function warn(msg) {
        if (hooks.suppressDeprecationWarnings === false &&
                (typeof console !==  'undefined') && console.warn) {
            console.warn('Deprecation warning: ' + msg);
        }
    }

    function deprecate(msg, fn) {
        var firstTime = true;

        return extend(function () {
            if (hooks.deprecationHandler != null) {
                hooks.deprecationHandler(null, msg);
            }
            if (firstTime) {
                var args = [];
                var arg;
                for (var i = 0; i < arguments.length; i++) {
                    arg = '';
                    if (typeof arguments[i] === 'object') {
                        arg += '\n[' + i + '] ';
                        for (var key in arguments[0]) {
                            arg += key + ': ' + arguments[0][key] + ', ';
                        }
                        arg = arg.slice(0, -2); // Remove trailing comma and space
                    } else {
                        arg = arguments[i];
                    }
                    args.push(arg);
                }
                warn(msg + '\nArguments: ' + Array.prototype.slice.call(args).join('') + '\n' + (new Error()).stack);
                firstTime = false;
            }
            return fn.apply(this, arguments);
        }, fn);
    }

    var deprecations = {};

    function deprecateSimple(name, msg) {
        if (hooks.deprecationHandler != null) {
            hooks.deprecationHandler(name, msg);
        }
        if (!deprecations[name]) {
            warn(msg);
            deprecations[name] = true;
        }
    }

    hooks.suppressDeprecationWarnings = false;
    hooks.deprecationHandler = null;

    function isFunction(input) {
        return input instanceof Function || Object.prototype.toString.call(input) === '[object Function]';
    }

    function set (config) {
        var prop, i;
        for (i in config) {
            prop = config[i];
            if (isFunction(prop)) {
                this[i] = prop;
            } else {
                this['_' + i] = prop;
            }
        }
        this._config = config;
        // Lenient ordinal parsing accepts just a number in addition to
        // number + (possibly) stuff coming from _dayOfMonthOrdinalParse.
        // TODO: Remove "ordinalParse" fallback in next major release.
        this._dayOfMonthOrdinalParseLenient = new RegExp(
            (this._dayOfMonthOrdinalParse.source || this._ordinalParse.source) +
                '|' + (/\d{1,2}/).source);
    }

    function mergeConfigs(parentConfig, childConfig) {
        var res = extend({}, parentConfig), prop;
        for (prop in childConfig) {
            if (hasOwnProp(childConfig, prop)) {
                if (isObject(parentConfig[prop]) && isObject(childConfig[prop])) {
                    res[prop] = {};
                    extend(res[prop], parentConfig[prop]);
                    extend(res[prop], childConfig[prop]);
                } else if (childConfig[prop] != null) {
                    res[prop] = childConfig[prop];
                } else {
                    delete res[prop];
                }
            }
        }
        for (prop in parentConfig) {
            if (hasOwnProp(parentConfig, prop) &&
                    !hasOwnProp(childConfig, prop) &&
                    isObject(parentConfig[prop])) {
                // make sure changes to properties don't modify parent config
                res[prop] = extend({}, res[prop]);
            }
        }
        return res;
    }

    function Locale(config) {
        if (config != null) {
            this.set(config);
        }
    }

    var keys;

    if (Object.keys) {
        keys = Object.keys;
    } else {
        keys = function (obj) {
            var i, res = [];
            for (i in obj) {
                if (hasOwnProp(obj, i)) {
                    res.push(i);
                }
            }
            return res;
        };
    }

    var defaultCalendar = {
        sameDay : '[Today at] LT',
        nextDay : '[Tomorrow at] LT',
        nextWeek : 'dddd [at] LT',
        lastDay : '[Yesterday at] LT',
        lastWeek : '[Last] dddd [at] LT',
        sameElse : 'L'
    };

    function calendar (key, mom, now) {
        var output = this._calendar[key] || this._calendar['sameElse'];
        return isFunction(output) ? output.call(mom, now) : output;
    }

    var defaultLongDateFormat = {
        LTS  : 'h:mm:ss A',
        LT   : 'h:mm A',
        L    : 'MM/DD/YYYY',
        LL   : 'MMMM D, YYYY',
        LLL  : 'MMMM D, YYYY h:mm A',
        LLLL : 'dddd, MMMM D, YYYY h:mm A'
    };

    function longDateFormat (key) {
        var format = this._longDateFormat[key],
            formatUpper = this._longDateFormat[key.toUpperCase()];

        if (format || !formatUpper) {
            return format;
        }

        this._longDateFormat[key] = formatUpper.replace(/MMMM|MM|DD|dddd/g, function (val) {
            return val.slice(1);
        });

        return this._longDateFormat[key];
    }

    var defaultInvalidDate = 'Invalid date';

    function invalidDate () {
        return this._invalidDate;
    }

    var defaultOrdinal = '%d';
    var defaultDayOfMonthOrdinalParse = /\d{1,2}/;

    function ordinal (number) {
        return this._ordinal.replace('%d', number);
    }

    var defaultRelativeTime = {
        future : 'in %s',
        past   : '%s ago',
        s  : 'a few seconds',
        ss : '%d seconds',
        m  : 'a minute',
        mm : '%d minutes',
        h  : 'an hour',
        hh : '%d hours',
        d  : 'a day',
        dd : '%d days',
        M  : 'a month',
        MM : '%d months',
        y  : 'a year',
        yy : '%d years'
    };

    function relativeTime (number, withoutSuffix, string, isFuture) {
        var output = this._relativeTime[string];
        return (isFunction(output)) ?
            output(number, withoutSuffix, string, isFuture) :
            output.replace(/%d/i, number);
    }

    function pastFuture (diff, output) {
        var format = this._relativeTime[diff > 0 ? 'future' : 'past'];
        return isFunction(format) ? format(output) : format.replace(/%s/i, output);
    }

    var aliases = {};

    function addUnitAlias (unit, shorthand) {
        var lowerCase = unit.toLowerCase();
        aliases[lowerCase] = aliases[lowerCase + 's'] = aliases[shorthand] = unit;
    }

    function normalizeUnits(units) {
        return typeof units === 'string' ? aliases[units] || aliases[units.toLowerCase()] : undefined;
    }

    function normalizeObjectUnits(inputObject) {
        var normalizedInput = {},
            normalizedProp,
            prop;

        for (prop in inputObject) {
            if (hasOwnProp(inputObject, prop)) {
                normalizedProp = normalizeUnits(prop);
                if (normalizedProp) {
                    normalizedInput[normalizedProp] = inputObject[prop];
                }
            }
        }

        return normalizedInput;
    }

    var priorities = {};

    function addUnitPriority(unit, priority) {
        priorities[unit] = priority;
    }

    function getPrioritizedUnits(unitsObj) {
        var units = [];
        for (var u in unitsObj) {
            units.push({unit: u, priority: priorities[u]});
        }
        units.sort(function (a, b) {
            return a.priority - b.priority;
        });
        return units;
    }

    function zeroFill(number, targetLength, forceSign) {
        var absNumber = '' + Math.abs(number),
            zerosToFill = targetLength - absNumber.length,
            sign = number >= 0;
        return (sign ? (forceSign ? '+' : '') : '-') +
            Math.pow(10, Math.max(0, zerosToFill)).toString().substr(1) + absNumber;
    }

    var formattingTokens = /(\[[^\[]*\])|(\\)?([Hh]mm(ss)?|Mo|MM?M?M?|Do|DDDo|DD?D?D?|ddd?d?|do?|w[o|w]?|W[o|W]?|Qo?|YYYYYY|YYYYY|YYYY|YY|gg(ggg?)?|GG(GGG?)?|e|E|a|A|hh?|HH?|kk?|mm?|ss?|S{1,9}|x|X|zz?|ZZ?|.)/g;

    var localFormattingTokens = /(\[[^\[]*\])|(\\)?(LTS|LT|LL?L?L?|l{1,4})/g;

    var formatFunctions = {};

    var formatTokenFunctions = {};

    // token:    'M'
    // padded:   ['MM', 2]
    // ordinal:  'Mo'
    // callback: function () { this.month() + 1 }
    function addFormatToken (token, padded, ordinal, callback) {
        var func = callback;
        if (typeof callback === 'string') {
            func = function () {
                return this[callback]();
            };
        }
        if (token) {
            formatTokenFunctions[token] = func;
        }
        if (padded) {
            formatTokenFunctions[padded[0]] = function () {
                return zeroFill(func.apply(this, arguments), padded[1], padded[2]);
            };
        }
        if (ordinal) {
            formatTokenFunctions[ordinal] = function () {
                return this.localeData().ordinal(func.apply(this, arguments), token);
            };
        }
    }

    function removeFormattingTokens(input) {
        if (input.match(/\[[\s\S]/)) {
            return input.replace(/^\[|\]$/g, '');
        }
        return input.replace(/\\/g, '');
    }

    function makeFormatFunction(format) {
        var array = format.match(formattingTokens), i, length;

        for (i = 0, length = array.length; i < length; i++) {
            if (formatTokenFunctions[array[i]]) {
                array[i] = formatTokenFunctions[array[i]];
            } else {
                array[i] = removeFormattingTokens(array[i]);
            }
        }

        return function (mom) {
            var output = '', i;
            for (i = 0; i < length; i++) {
                output += isFunction(array[i]) ? array[i].call(mom, format) : array[i];
            }
            return output;
        };
    }

    // format date using native date object
    function formatMoment(m, format) {
        if (!m.isValid()) {
            return m.localeData().invalidDate();
        }

        format = expandFormat(format, m.localeData());
        formatFunctions[format] = formatFunctions[format] || makeFormatFunction(format);

        return formatFunctions[format](m);
    }

    function expandFormat(format, locale) {
        var i = 5;

        function replaceLongDateFormatTokens(input) {
            return locale.longDateFormat(input) || input;
        }

        localFormattingTokens.lastIndex = 0;
        while (i >= 0 && localFormattingTokens.test(format)) {
            format = format.replace(localFormattingTokens, replaceLongDateFormatTokens);
            localFormattingTokens.lastIndex = 0;
            i -= 1;
        }

        return format;
    }

    var match1         = /\d/;            //       0 - 9
    var match2         = /\d\d/;          //      00 - 99
    var match3         = /\d{3}/;         //     000 - 999
    var match4         = /\d{4}/;         //    0000 - 9999
    var match6         = /[+-]?\d{6}/;    // -999999 - 999999
    var match1to2      = /\d\d?/;         //       0 - 99
    var match3to4      = /\d\d\d\d?/;     //     999 - 9999
    var match5to6      = /\d\d\d\d\d\d?/; //   99999 - 999999
    var match1to3      = /\d{1,3}/;       //       0 - 999
    var match1to4      = /\d{1,4}/;       //       0 - 9999
    var match1to6      = /[+-]?\d{1,6}/;  // -999999 - 999999

    var matchUnsigned  = /\d+/;           //       0 - inf
    var matchSigned    = /[+-]?\d+/;      //    -inf - inf

    var matchOffset    = /Z|[+-]\d\d:?\d\d/gi; // +00:00 -00:00 +0000 -0000 or Z
    var matchShortOffset = /Z|[+-]\d\d(?::?\d\d)?/gi; // +00 -00 +00:00 -00:00 +0000 -0000 or Z

    var matchTimestamp = /[+-]?\d+(\.\d{1,3})?/; // 123456789 123456789.123

    // any word (or two) characters or numbers including two/three word month in arabic.
    // includes scottish gaelic two word and hyphenated months
    var matchWord = /[0-9]{0,256}['a-z\u00A0-\u05FF\u0700-\uD7FF\uF900-\uFDCF\uFDF0-\uFF07\uFF10-\uFFEF]{1,256}|[\u0600-\u06FF\/]{1,256}(\s*?[\u0600-\u06FF]{1,256}){1,2}/i;

    var regexes = {};

    function addRegexToken (token, regex, strictRegex) {
        regexes[token] = isFunction(regex) ? regex : function (isStrict, localeData) {
            return (isStrict && strictRegex) ? strictRegex : regex;
        };
    }

    function getParseRegexForToken (token, config) {
        if (!hasOwnProp(regexes, token)) {
            return new RegExp(unescapeFormat(token));
        }

        return regexes[token](config._strict, config._locale);
    }

    // Code from http://stackoverflow.com/questions/3561493/is-there-a-regexp-escape-function-in-javascript
    function unescapeFormat(s) {
        return regexEscape(s.replace('\\', '').replace(/\\(\[)|\\(\])|\[([^\]\[]*)\]|\\(.)/g, function (matched, p1, p2, p3, p4) {
            return p1 || p2 || p3 || p4;
        }));
    }

    function regexEscape(s) {
        return s.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
    }

    var tokens = {};

    function addParseToken (token, callback) {
        var i, func = callback;
        if (typeof token === 'string') {
            token = [token];
        }
        if (isNumber(callback)) {
            func = function (input, array) {
                array[callback] = toInt(input);
            };
        }
        for (i = 0; i < token.length; i++) {
            tokens[token[i]] = func;
        }
    }

    function addWeekParseToken (token, callback) {
        addParseToken(token, function (input, array, config, token) {
            config._w = config._w || {};
            callback(input, config._w, config, token);
        });
    }

    function addTimeToArrayFromToken(token, input, config) {
        if (input != null && hasOwnProp(tokens, token)) {
            tokens[token](input, config._a, config, token);
        }
    }

    var YEAR = 0;
    var MONTH = 1;
    var DATE = 2;
    var HOUR = 3;
    var MINUTE = 4;
    var SECOND = 5;
    var MILLISECOND = 6;
    var WEEK = 7;
    var WEEKDAY = 8;

    // FORMATTING

    addFormatToken('Y', 0, 0, function () {
        var y = this.year();
        return y <= 9999 ? '' + y : '+' + y;
    });

    addFormatToken(0, ['YY', 2], 0, function () {
        return this.year() % 100;
    });

    addFormatToken(0, ['YYYY',   4],       0, 'year');
    addFormatToken(0, ['YYYYY',  5],       0, 'year');
    addFormatToken(0, ['YYYYYY', 6, true], 0, 'year');

    // ALIASES

    addUnitAlias('year', 'y');

    // PRIORITIES

    addUnitPriority('year', 1);

    // PARSING

    addRegexToken('Y',      matchSigned);
    addRegexToken('YY',     match1to2, match2);
    addRegexToken('YYYY',   match1to4, match4);
    addRegexToken('YYYYY',  match1to6, match6);
    addRegexToken('YYYYYY', match1to6, match6);

    addParseToken(['YYYYY', 'YYYYYY'], YEAR);
    addParseToken('YYYY', function (input, array) {
        array[YEAR] = input.length === 2 ? hooks.parseTwoDigitYear(input) : toInt(input);
    });
    addParseToken('YY', function (input, array) {
        array[YEAR] = hooks.parseTwoDigitYear(input);
    });
    addParseToken('Y', function (input, array) {
        array[YEAR] = parseInt(input, 10);
    });

    // HELPERS

    function daysInYear(year) {
        return isLeapYear(year) ? 366 : 365;
    }

    function isLeapYear(year) {
        return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
    }

    // HOOKS

    hooks.parseTwoDigitYear = function (input) {
        return toInt(input) + (toInt(input) > 68 ? 1900 : 2000);
    };

    // MOMENTS

    var getSetYear = makeGetSet('FullYear', true);

    function getIsLeapYear () {
        return isLeapYear(this.year());
    }

    function makeGetSet (unit, keepTime) {
        return function (value) {
            if (value != null) {
                set$1(this, unit, value);
                hooks.updateOffset(this, keepTime);
                return this;
            } else {
                return get(this, unit);
            }
        };
    }

    function get (mom, unit) {
        return mom.isValid() ?
            mom._d['get' + (mom._isUTC ? 'UTC' : '') + unit]() : NaN;
    }

    function set$1 (mom, unit, value) {
        if (mom.isValid() && !isNaN(value)) {
            if (unit === 'FullYear' && isLeapYear(mom.year()) && mom.month() === 1 && mom.date() === 29) {
                mom._d['set' + (mom._isUTC ? 'UTC' : '') + unit](value, mom.month(), daysInMonth(value, mom.month()));
            }
            else {
                mom._d['set' + (mom._isUTC ? 'UTC' : '') + unit](value);
            }
        }
    }

    // MOMENTS

    function stringGet (units) {
        units = normalizeUnits(units);
        if (isFunction(this[units])) {
            return this[units]();
        }
        return this;
    }


    function stringSet (units, value) {
        if (typeof units === 'object') {
            units = normalizeObjectUnits(units);
            var prioritized = getPrioritizedUnits(units);
            for (var i = 0; i < prioritized.length; i++) {
                this[prioritized[i].unit](units[prioritized[i].unit]);
            }
        } else {
            units = normalizeUnits(units);
            if (isFunction(this[units])) {
                return this[units](value);
            }
        }
        return this;
    }

    function mod(n, x) {
        return ((n % x) + x) % x;
    }

    var indexOf;

    if (Array.prototype.indexOf) {
        indexOf = Array.prototype.indexOf;
    } else {
        indexOf = function (o) {
            // I know
            var i;
            for (i = 0; i < this.length; ++i) {
                if (this[i] === o) {
                    return i;
                }
            }
            return -1;
        };
    }

    function daysInMonth(year, month) {
        if (isNaN(year) || isNaN(month)) {
            return NaN;
        }
        var modMonth = mod(month, 12);
        year += (month - modMonth) / 12;
        return modMonth === 1 ? (isLeapYear(year) ? 29 : 28) : (31 - modMonth % 7 % 2);
    }

    // FORMATTING

    addFormatToken('M', ['MM', 2], 'Mo', function () {
        return this.month() + 1;
    });

    addFormatToken('MMM', 0, 0, function (format) {
        return this.localeData().monthsShort(this, format);
    });

    addFormatToken('MMMM', 0, 0, function (format) {
        return this.localeData().months(this, format);
    });

    // ALIASES

    addUnitAlias('month', 'M');

    // PRIORITY

    addUnitPriority('month', 8);

    // PARSING

    addRegexToken('M',    match1to2);
    addRegexToken('MM',   match1to2, match2);
    addRegexToken('MMM',  function (isStrict, locale) {
        return locale.monthsShortRegex(isStrict);
    });
    addRegexToken('MMMM', function (isStrict, locale) {
        return locale.monthsRegex(isStrict);
    });

    addParseToken(['M', 'MM'], function (input, array) {
        array[MONTH] = toInt(input) - 1;
    });

    addParseToken(['MMM', 'MMMM'], function (input, array, config, token) {
        var month = config._locale.monthsParse(input, token, config._strict);
        // if we didn't find a month name, mark the date as invalid.
        if (month != null) {
            array[MONTH] = month;
        } else {
            getParsingFlags(config).invalidMonth = input;
        }
    });

    // LOCALES

    var MONTHS_IN_FORMAT = /D[oD]?(\[[^\[\]]*\]|\s)+MMMM?/;
    var defaultLocaleMonths = 'January_February_March_April_May_June_July_August_September_October_November_December'.split('_');
    function localeMonths (m, format) {
        if (!m) {
            return isArray(this._months) ? this._months :
                this._months['standalone'];
        }
        return isArray(this._months) ? this._months[m.month()] :
            this._months[(this._months.isFormat || MONTHS_IN_FORMAT).test(format) ? 'format' : 'standalone'][m.month()];
    }

    var defaultLocaleMonthsShort = 'Jan_Feb_Mar_Apr_May_Jun_Jul_Aug_Sep_Oct_Nov_Dec'.split('_');
    function localeMonthsShort (m, format) {
        if (!m) {
            return isArray(this._monthsShort) ? this._monthsShort :
                this._monthsShort['standalone'];
        }
        return isArray(this._monthsShort) ? this._monthsShort[m.month()] :
            this._monthsShort[MONTHS_IN_FORMAT.test(format) ? 'format' : 'standalone'][m.month()];
    }

    function handleStrictParse(monthName, format, strict) {
        var i, ii, mom, llc = monthName.toLocaleLowerCase();
        if (!this._monthsParse) {
            // this is not used
            this._monthsParse = [];
            this._longMonthsParse = [];
            this._shortMonthsParse = [];
            for (i = 0; i < 12; ++i) {
                mom = createUTC([2000, i]);
                this._shortMonthsParse[i] = this.monthsShort(mom, '').toLocaleLowerCase();
                this._longMonthsParse[i] = this.months(mom, '').toLocaleLowerCase();
            }
        }

        if (strict) {
            if (format === 'MMM') {
                ii = indexOf.call(this._shortMonthsParse, llc);
                return ii !== -1 ? ii : null;
            } else {
                ii = indexOf.call(this._longMonthsParse, llc);
                return ii !== -1 ? ii : null;
            }
        } else {
            if (format === 'MMM') {
                ii = indexOf.call(this._shortMonthsParse, llc);
                if (ii !== -1) {
                    return ii;
                }
                ii = indexOf.call(this._longMonthsParse, llc);
                return ii !== -1 ? ii : null;
            } else {
                ii = indexOf.call(this._longMonthsParse, llc);
                if (ii !== -1) {
                    return ii;
                }
                ii = indexOf.call(this._shortMonthsParse, llc);
                return ii !== -1 ? ii : null;
            }
        }
    }

    function localeMonthsParse (monthName, format, strict) {
        var i, mom, regex;

        if (this._monthsParseExact) {
            return handleStrictParse.call(this, monthName, format, strict);
        }

        if (!this._monthsParse) {
            this._monthsParse = [];
            this._longMonthsParse = [];
            this._shortMonthsParse = [];
        }

        // TODO: add sorting
        // Sorting makes sure if one month (or abbr) is a prefix of another
        // see sorting in computeMonthsParse
        for (i = 0; i < 12; i++) {
            // make the regex if we don't have it already
            mom = createUTC([2000, i]);
            if (strict && !this._longMonthsParse[i]) {
                this._longMonthsParse[i] = new RegExp('^' + this.months(mom, '').replace('.', '') + '$', 'i');
                this._shortMonthsParse[i] = new RegExp('^' + this.monthsShort(mom, '').replace('.', '') + '$', 'i');
            }
            if (!strict && !this._monthsParse[i]) {
                regex = '^' + this.months(mom, '') + '|^' + this.monthsShort(mom, '');
                this._monthsParse[i] = new RegExp(regex.replace('.', ''), 'i');
            }
            // test the regex
            if (strict && format === 'MMMM' && this._longMonthsParse[i].test(monthName)) {
                return i;
            } else if (strict && format === 'MMM' && this._shortMonthsParse[i].test(monthName)) {
                return i;
            } else if (!strict && this._monthsParse[i].test(monthName)) {
                return i;
            }
        }
    }

    // MOMENTS

    function setMonth (mom, value) {
        var dayOfMonth;

        if (!mom.isValid()) {
            // No op
            return mom;
        }

        if (typeof value === 'string') {
            if (/^\d+$/.test(value)) {
                value = toInt(value);
            } else {
                value = mom.localeData().monthsParse(value);
                // TODO: Another silent failure?
                if (!isNumber(value)) {
                    return mom;
                }
            }
        }

        dayOfMonth = Math.min(mom.date(), daysInMonth(mom.year(), value));
        mom._d['set' + (mom._isUTC ? 'UTC' : '') + 'Month'](value, dayOfMonth);
        return mom;
    }

    function getSetMonth (value) {
        if (value != null) {
            setMonth(this, value);
            hooks.updateOffset(this, true);
            return this;
        } else {
            return get(this, 'Month');
        }
    }

    function getDaysInMonth () {
        return daysInMonth(this.year(), this.month());
    }

    var defaultMonthsShortRegex = matchWord;
    function monthsShortRegex (isStrict) {
        if (this._monthsParseExact) {
            if (!hasOwnProp(this, '_monthsRegex')) {
                computeMonthsParse.call(this);
            }
            if (isStrict) {
                return this._monthsShortStrictRegex;
            } else {
                return this._monthsShortRegex;
            }
        } else {
            if (!hasOwnProp(this, '_monthsShortRegex')) {
                this._monthsShortRegex = defaultMonthsShortRegex;
            }
            return this._monthsShortStrictRegex && isStrict ?
                this._monthsShortStrictRegex : this._monthsShortRegex;
        }
    }

    var defaultMonthsRegex = matchWord;
    function monthsRegex (isStrict) {
        if (this._monthsParseExact) {
            if (!hasOwnProp(this, '_monthsRegex')) {
                computeMonthsParse.call(this);
            }
            if (isStrict) {
                return this._monthsStrictRegex;
            } else {
                return this._monthsRegex;
            }
        } else {
            if (!hasOwnProp(this, '_monthsRegex')) {
                this._monthsRegex = defaultMonthsRegex;
            }
            return this._monthsStrictRegex && isStrict ?
                this._monthsStrictRegex : this._monthsRegex;
        }
    }

    function computeMonthsParse () {
        function cmpLenRev(a, b) {
            return b.length - a.length;
        }

        var shortPieces = [], longPieces = [], mixedPieces = [],
            i, mom;
        for (i = 0; i < 12; i++) {
            // make the regex if we don't have it already
            mom = createUTC([2000, i]);
            shortPieces.push(this.monthsShort(mom, ''));
            longPieces.push(this.months(mom, ''));
            mixedPieces.push(this.months(mom, ''));
            mixedPieces.push(this.monthsShort(mom, ''));
        }
        // Sorting makes sure if one month (or abbr) is a prefix of another it
        // will match the longer piece.
        shortPieces.sort(cmpLenRev);
        longPieces.sort(cmpLenRev);
        mixedPieces.sort(cmpLenRev);
        for (i = 0; i < 12; i++) {
            shortPieces[i] = regexEscape(shortPieces[i]);
            longPieces[i] = regexEscape(longPieces[i]);
        }
        for (i = 0; i < 24; i++) {
            mixedPieces[i] = regexEscape(mixedPieces[i]);
        }

        this._monthsRegex = new RegExp('^(' + mixedPieces.join('|') + ')', 'i');
        this._monthsShortRegex = this._monthsRegex;
        this._monthsStrictRegex = new RegExp('^(' + longPieces.join('|') + ')', 'i');
        this._monthsShortStrictRegex = new RegExp('^(' + shortPieces.join('|') + ')', 'i');
    }

    function createDate (y, m, d, h, M, s, ms) {
        // can't just apply() to create a date:
        // https://stackoverflow.com/q/181348
        var date;
        // the date constructor remaps years 0-99 to 1900-1999
        if (y < 100 && y >= 0) {
            // preserve leap years using a full 400 year cycle, then reset
            date = new Date(y + 400, m, d, h, M, s, ms);
            if (isFinite(date.getFullYear())) {
                date.setFullYear(y);
            }
        } else {
            date = new Date(y, m, d, h, M, s, ms);
        }

        return date;
    }

    function createUTCDate (y) {
        var date;
        // the Date.UTC function remaps years 0-99 to 1900-1999
        if (y < 100 && y >= 0) {
            var args = Array.prototype.slice.call(arguments);
            // preserve leap years using a full 400 year cycle, then reset
            args[0] = y + 400;
            date = new Date(Date.UTC.apply(null, args));
            if (isFinite(date.getUTCFullYear())) {
                date.setUTCFullYear(y);
            }
        } else {
            date = new Date(Date.UTC.apply(null, arguments));
        }

        return date;
    }

    // start-of-first-week - start-of-year
    function firstWeekOffset(year, dow, doy) {
        var // first-week day -- which january is always in the first week (4 for iso, 1 for other)
            fwd = 7 + dow - doy,
            // first-week day local weekday -- which local weekday is fwd
            fwdlw = (7 + createUTCDate(year, 0, fwd).getUTCDay() - dow) % 7;

        return -fwdlw + fwd - 1;
    }

    // https://en.wikipedia.org/wiki/ISO_week_date#Calculating_a_date_given_the_year.2C_week_number_and_weekday
    function dayOfYearFromWeeks(year, week, weekday, dow, doy) {
        var localWeekday = (7 + weekday - dow) % 7,
            weekOffset = firstWeekOffset(year, dow, doy),
            dayOfYear = 1 + 7 * (week - 1) + localWeekday + weekOffset,
            resYear, resDayOfYear;

        if (dayOfYear <= 0) {
            resYear = year - 1;
            resDayOfYear = daysInYear(resYear) + dayOfYear;
        } else if (dayOfYear > daysInYear(year)) {
            resYear = year + 1;
            resDayOfYear = dayOfYear - daysInYear(year);
        } else {
            resYear = year;
            resDayOfYear = dayOfYear;
        }

        return {
            year: resYear,
            dayOfYear: resDayOfYear
        };
    }

    function weekOfYear(mom, dow, doy) {
        var weekOffset = firstWeekOffset(mom.year(), dow, doy),
            week = Math.floor((mom.dayOfYear() - weekOffset - 1) / 7) + 1,
            resWeek, resYear;

        if (week < 1) {
            resYear = mom.year() - 1;
            resWeek = week + weeksInYear(resYear, dow, doy);
        } else if (week > weeksInYear(mom.year(), dow, doy)) {
            resWeek = week - weeksInYear(mom.year(), dow, doy);
            resYear = mom.year() + 1;
        } else {
            resYear = mom.year();
            resWeek = week;
        }

        return {
            week: resWeek,
            year: resYear
        };
    }

    function weeksInYear(year, dow, doy) {
        var weekOffset = firstWeekOffset(year, dow, doy),
            weekOffsetNext = firstWeekOffset(year + 1, dow, doy);
        return (daysInYear(year) - weekOffset + weekOffsetNext) / 7;
    }

    // FORMATTING

    addFormatToken('w', ['ww', 2], 'wo', 'week');
    addFormatToken('W', ['WW', 2], 'Wo', 'isoWeek');

    // ALIASES

    addUnitAlias('week', 'w');
    addUnitAlias('isoWeek', 'W');

    // PRIORITIES

    addUnitPriority('week', 5);
    addUnitPriority('isoWeek', 5);

    // PARSING

    addRegexToken('w',  match1to2);
    addRegexToken('ww', match1to2, match2);
    addRegexToken('W',  match1to2);
    addRegexToken('WW', match1to2, match2);

    addWeekParseToken(['w', 'ww', 'W', 'WW'], function (input, week, config, token) {
        week[token.substr(0, 1)] = toInt(input);
    });

    // HELPERS

    // LOCALES

    function localeWeek (mom) {
        return weekOfYear(mom, this._week.dow, this._week.doy).week;
    }

    var defaultLocaleWeek = {
        dow : 0, // Sunday is the first day of the week.
        doy : 6  // The week that contains Jan 6th is the first week of the year.
    };

    function localeFirstDayOfWeek () {
        return this._week.dow;
    }

    function localeFirstDayOfYear () {
        return this._week.doy;
    }

    // MOMENTS

    function getSetWeek (input) {
        var week = this.localeData().week(this);
        return input == null ? week : this.add((input - week) * 7, 'd');
    }

    function getSetISOWeek (input) {
        var week = weekOfYear(this, 1, 4).week;
        return input == null ? week : this.add((input - week) * 7, 'd');
    }

    // FORMATTING

    addFormatToken('d', 0, 'do', 'day');

    addFormatToken('dd', 0, 0, function (format) {
        return this.localeData().weekdaysMin(this, format);
    });

    addFormatToken('ddd', 0, 0, function (format) {
        return this.localeData().weekdaysShort(this, format);
    });

    addFormatToken('dddd', 0, 0, function (format) {
        return this.localeData().weekdays(this, format);
    });

    addFormatToken('e', 0, 0, 'weekday');
    addFormatToken('E', 0, 0, 'isoWeekday');

    // ALIASES

    addUnitAlias('day', 'd');
    addUnitAlias('weekday', 'e');
    addUnitAlias('isoWeekday', 'E');

    // PRIORITY
    addUnitPriority('day', 11);
    addUnitPriority('weekday', 11);
    addUnitPriority('isoWeekday', 11);

    // PARSING

    addRegexToken('d',    match1to2);
    addRegexToken('e',    match1to2);
    addRegexToken('E',    match1to2);
    addRegexToken('dd',   function (isStrict, locale) {
        return locale.weekdaysMinRegex(isStrict);
    });
    addRegexToken('ddd',   function (isStrict, locale) {
        return locale.weekdaysShortRegex(isStrict);
    });
    addRegexToken('dddd',   function (isStrict, locale) {
        return locale.weekdaysRegex(isStrict);
    });

    addWeekParseToken(['dd', 'ddd', 'dddd'], function (input, week, config, token) {
        var weekday = config._locale.weekdaysParse(input, token, config._strict);
        // if we didn't get a weekday name, mark the date as invalid
        if (weekday != null) {
            week.d = weekday;
        } else {
            getParsingFlags(config).invalidWeekday = input;
        }
    });

    addWeekParseToken(['d', 'e', 'E'], function (input, week, config, token) {
        week[token] = toInt(input);
    });

    // HELPERS

    function parseWeekday(input, locale) {
        if (typeof input !== 'string') {
            return input;
        }

        if (!isNaN(input)) {
            return parseInt(input, 10);
        }

        input = locale.weekdaysParse(input);
        if (typeof input === 'number') {
            return input;
        }

        return null;
    }

    function parseIsoWeekday(input, locale) {
        if (typeof input === 'string') {
            return locale.weekdaysParse(input) % 7 || 7;
        }
        return isNaN(input) ? null : input;
    }

    // LOCALES
    function shiftWeekdays (ws, n) {
        return ws.slice(n, 7).concat(ws.slice(0, n));
    }

    var defaultLocaleWeekdays = 'Sunday_Monday_Tuesday_Wednesday_Thursday_Friday_Saturday'.split('_');
    function localeWeekdays (m, format) {
        var weekdays = isArray(this._weekdays) ? this._weekdays :
            this._weekdays[(m && m !== true && this._weekdays.isFormat.test(format)) ? 'format' : 'standalone'];
        return (m === true) ? shiftWeekdays(weekdays, this._week.dow)
            : (m) ? weekdays[m.day()] : weekdays;
    }

    var defaultLocaleWeekdaysShort = 'Sun_Mon_Tue_Wed_Thu_Fri_Sat'.split('_');
    function localeWeekdaysShort (m) {
        return (m === true) ? shiftWeekdays(this._weekdaysShort, this._week.dow)
            : (m) ? this._weekdaysShort[m.day()] : this._weekdaysShort;
    }

    var defaultLocaleWeekdaysMin = 'Su_Mo_Tu_We_Th_Fr_Sa'.split('_');
    function localeWeekdaysMin (m) {
        return (m === true) ? shiftWeekdays(this._weekdaysMin, this._week.dow)
            : (m) ? this._weekdaysMin[m.day()] : this._weekdaysMin;
    }

    function handleStrictParse$1(weekdayName, format, strict) {
        var i, ii, mom, llc = weekdayName.toLocaleLowerCase();
        if (!this._weekdaysParse) {
            this._weekdaysParse = [];
            this._shortWeekdaysParse = [];
            this._minWeekdaysParse = [];

            for (i = 0; i < 7; ++i) {
                mom = createUTC([2000, 1]).day(i);
                this._minWeekdaysParse[i] = this.weekdaysMin(mom, '').toLocaleLowerCase();
                this._shortWeekdaysParse[i] = this.weekdaysShort(mom, '').toLocaleLowerCase();
                this._weekdaysParse[i] = this.weekdays(mom, '').toLocaleLowerCase();
            }
        }

        if (strict) {
            if (format === 'dddd') {
                ii = indexOf.call(this._weekdaysParse, llc);
                return ii !== -1 ? ii : null;
            } else if (format === 'ddd') {
                ii = indexOf.call(this._shortWeekdaysParse, llc);
                return ii !== -1 ? ii : null;
            } else {
                ii = indexOf.call(this._minWeekdaysParse, llc);
                return ii !== -1 ? ii : null;
            }
        } else {
            if (format === 'dddd') {
                ii = indexOf.call(this._weekdaysParse, llc);
                if (ii !== -1) {
                    return ii;
                }
                ii = indexOf.call(this._shortWeekdaysParse, llc);
                if (ii !== -1) {
                    return ii;
                }
                ii = indexOf.call(this._minWeekdaysParse, llc);
                return ii !== -1 ? ii : null;
            } else if (format === 'ddd') {
                ii = indexOf.call(this._shortWeekdaysParse, llc);
                if (ii !== -1) {
                    return ii;
                }
                ii = indexOf.call(this._weekdaysParse, llc);
                if (ii !== -1) {
                    return ii;
                }
                ii = indexOf.call(this._minWeekdaysParse, llc);
                return ii !== -1 ? ii : null;
            } else {
                ii = indexOf.call(this._minWeekdaysParse, llc);
                if (ii !== -1) {
                    return ii;
                }
                ii = indexOf.call(this._weekdaysParse, llc);
                if (ii !== -1) {
                    return ii;
                }
                ii = indexOf.call(this._shortWeekdaysParse, llc);
                return ii !== -1 ? ii : null;
            }
        }
    }

    function localeWeekdaysParse (weekdayName, format, strict) {
        var i, mom, regex;

        if (this._weekdaysParseExact) {
            return handleStrictParse$1.call(this, weekdayName, format, strict);
        }

        if (!this._weekdaysParse) {
            this._weekdaysParse = [];
            this._minWeekdaysParse = [];
            this._shortWeekdaysParse = [];
            this._fullWeekdaysParse = [];
        }

        for (i = 0; i < 7; i++) {
            // make the regex if we don't have it already

            mom = createUTC([2000, 1]).day(i);
            if (strict && !this._fullWeekdaysParse[i]) {
                this._fullWeekdaysParse[i] = new RegExp('^' + this.weekdays(mom, '').replace('.', '\\.?') + '$', 'i');
                this._shortWeekdaysParse[i] = new RegExp('^' + this.weekdaysShort(mom, '').replace('.', '\\.?') + '$', 'i');
                this._minWeekdaysParse[i] = new RegExp('^' + this.weekdaysMin(mom, '').replace('.', '\\.?') + '$', 'i');
            }
            if (!this._weekdaysParse[i]) {
                regex = '^' + this.weekdays(mom, '') + '|^' + this.weekdaysShort(mom, '') + '|^' + this.weekdaysMin(mom, '');
                this._weekdaysParse[i] = new RegExp(regex.replace('.', ''), 'i');
            }
            // test the regex
            if (strict && format === 'dddd' && this._fullWeekdaysParse[i].test(weekdayName)) {
                return i;
            } else if (strict && format === 'ddd' && this._shortWeekdaysParse[i].test(weekdayName)) {
                return i;
            } else if (strict && format === 'dd' && this._minWeekdaysParse[i].test(weekdayName)) {
                return i;
            } else if (!strict && this._weekdaysParse[i].test(weekdayName)) {
                return i;
            }
        }
    }

    // MOMENTS

    function getSetDayOfWeek (input) {
        if (!this.isValid()) {
            return input != null ? this : NaN;
        }
        var day = this._isUTC ? this._d.getUTCDay() : this._d.getDay();
        if (input != null) {
            input = parseWeekday(input, this.localeData());
            return this.add(input - day, 'd');
        } else {
            return day;
        }
    }

    function getSetLocaleDayOfWeek (input) {
        if (!this.isValid()) {
            return input != null ? this : NaN;
        }
        var weekday = (this.day() + 7 - this.localeData()._week.dow) % 7;
        return input == null ? weekday : this.add(input - weekday, 'd');
    }

    function getSetISODayOfWeek (input) {
        if (!this.isValid()) {
            return input != null ? this : NaN;
        }

        // behaves the same as moment#day except
        // as a getter, returns 7 instead of 0 (1-7 range instead of 0-6)
        // as a setter, sunday should belong to the previous week.

        if (input != null) {
            var weekday = parseIsoWeekday(input, this.localeData());
            return this.day(this.day() % 7 ? weekday : weekday - 7);
        } else {
            return this.day() || 7;
        }
    }

    var defaultWeekdaysRegex = matchWord;
    function weekdaysRegex (isStrict) {
        if (this._weekdaysParseExact) {
            if (!hasOwnProp(this, '_weekdaysRegex')) {
                computeWeekdaysParse.call(this);
            }
            if (isStrict) {
                return this._weekdaysStrictRegex;
            } else {
                return this._weekdaysRegex;
            }
        } else {
            if (!hasOwnProp(this, '_weekdaysRegex')) {
                this._weekdaysRegex = defaultWeekdaysRegex;
            }
            return this._weekdaysStrictRegex && isStrict ?
                this._weekdaysStrictRegex : this._weekdaysRegex;
        }
    }

    var defaultWeekdaysShortRegex = matchWord;
    function weekdaysShortRegex (isStrict) {
        if (this._weekdaysParseExact) {
            if (!hasOwnProp(this, '_weekdaysRegex')) {
                computeWeekdaysParse.call(this);
            }
            if (isStrict) {
                return this._weekdaysShortStrictRegex;
            } else {
                return this._weekdaysShortRegex;
            }
        } else {
            if (!hasOwnProp(this, '_weekdaysShortRegex')) {
                this._weekdaysShortRegex = defaultWeekdaysShortRegex;
            }
            return this._weekdaysShortStrictRegex && isStrict ?
                this._weekdaysShortStrictRegex : this._weekdaysShortRegex;
        }
    }

    var defaultWeekdaysMinRegex = matchWord;
    function weekdaysMinRegex (isStrict) {
        if (this._weekdaysParseExact) {
            if (!hasOwnProp(this, '_weekdaysRegex')) {
                computeWeekdaysParse.call(this);
            }
            if (isStrict) {
                return this._weekdaysMinStrictRegex;
            } else {
                return this._weekdaysMinRegex;
            }
        } else {
            if (!hasOwnProp(this, '_weekdaysMinRegex')) {
                this._weekdaysMinRegex = defaultWeekdaysMinRegex;
            }
            return this._weekdaysMinStrictRegex && isStrict ?
                this._weekdaysMinStrictRegex : this._weekdaysMinRegex;
        }
    }


    function computeWeekdaysParse () {
        function cmpLenRev(a, b) {
            return b.length - a.length;
        }

        var minPieces = [], shortPieces = [], longPieces = [], mixedPieces = [],
            i, mom, minp, shortp, longp;
        for (i = 0; i < 7; i++) {
            // make the regex if we don't have it already
            mom = createUTC([2000, 1]).day(i);
            minp = this.weekdaysMin(mom, '');
            shortp = this.weekdaysShort(mom, '');
            longp = this.weekdays(mom, '');
            minPieces.push(minp);
            shortPieces.push(shortp);
            longPieces.push(longp);
            mixedPieces.push(minp);
            mixedPieces.push(shortp);
            mixedPieces.push(longp);
        }
        // Sorting makes sure if one weekday (or abbr) is a prefix of another it
        // will match the longer piece.
        minPieces.sort(cmpLenRev);
        shortPieces.sort(cmpLenRev);
        longPieces.sort(cmpLenRev);
        mixedPieces.sort(cmpLenRev);
        for (i = 0; i < 7; i++) {
            shortPieces[i] = regexEscape(shortPieces[i]);
            longPieces[i] = regexEscape(longPieces[i]);
            mixedPieces[i] = regexEscape(mixedPieces[i]);
        }

        this._weekdaysRegex = new RegExp('^(' + mixedPieces.join('|') + ')', 'i');
        this._weekdaysShortRegex = this._weekdaysRegex;
        this._weekdaysMinRegex = this._weekdaysRegex;

        this._weekdaysStrictRegex = new RegExp('^(' + longPieces.join('|') + ')', 'i');
        this._weekdaysShortStrictRegex = new RegExp('^(' + shortPieces.join('|') + ')', 'i');
        this._weekdaysMinStrictRegex = new RegExp('^(' + minPieces.join('|') + ')', 'i');
    }

    // FORMATTING

    function hFormat() {
        return this.hours() % 12 || 12;
    }

    function kFormat() {
        return this.hours() || 24;
    }

    addFormatToken('H', ['HH', 2], 0, 'hour');
    addFormatToken('h', ['hh', 2], 0, hFormat);
    addFormatToken('k', ['kk', 2], 0, kFormat);

    addFormatToken('hmm', 0, 0, function () {
        return '' + hFormat.apply(this) + zeroFill(this.minutes(), 2);
    });

    addFormatToken('hmmss', 0, 0, function () {
        return '' + hFormat.apply(this) + zeroFill(this.minutes(), 2) +
            zeroFill(this.seconds(), 2);
    });

    addFormatToken('Hmm', 0, 0, function () {
        return '' + this.hours() + zeroFill(this.minutes(), 2);
    });

    addFormatToken('Hmmss', 0, 0, function () {
        return '' + this.hours() + zeroFill(this.minutes(), 2) +
            zeroFill(this.seconds(), 2);
    });

    function meridiem (token, lowercase) {
        addFormatToken(token, 0, 0, function () {
            return this.localeData().meridiem(this.hours(), this.minutes(), lowercase);
        });
    }

    meridiem('a', true);
    meridiem('A', false);

    // ALIASES

    addUnitAlias('hour', 'h');

    // PRIORITY
    addUnitPriority('hour', 13);

    // PARSING

    function matchMeridiem (isStrict, locale) {
        return locale._meridiemParse;
    }

    addRegexToken('a',  matchMeridiem);
    addRegexToken('A',  matchMeridiem);
    addRegexToken('H',  match1to2);
    addRegexToken('h',  match1to2);
    addRegexToken('k',  match1to2);
    addRegexToken('HH', match1to2, match2);
    addRegexToken('hh', match1to2, match2);
    addRegexToken('kk', match1to2, match2);

    addRegexToken('hmm', match3to4);
    addRegexToken('hmmss', match5to6);
    addRegexToken('Hmm', match3to4);
    addRegexToken('Hmmss', match5to6);

    addParseToken(['H', 'HH'], HOUR);
    addParseToken(['k', 'kk'], function (input, array, config) {
        var kInput = toInt(input);
        array[HOUR] = kInput === 24 ? 0 : kInput;
    });
    addParseToken(['a', 'A'], function (input, array, config) {
        config._isPm = config._locale.isPM(input);
        config._meridiem = input;
    });
    addParseToken(['h', 'hh'], function (input, array, config) {
        array[HOUR] = toInt(input);
        getParsingFlags(config).bigHour = true;
    });
    addParseToken('hmm', function (input, array, config) {
        var pos = input.length - 2;
        array[HOUR] = toInt(input.substr(0, pos));
        array[MINUTE] = toInt(input.substr(pos));
        getParsingFlags(config).bigHour = true;
    });
    addParseToken('hmmss', function (input, array, config) {
        var pos1 = input.length - 4;
        var pos2 = input.length - 2;
        array[HOUR] = toInt(input.substr(0, pos1));
        array[MINUTE] = toInt(input.substr(pos1, 2));
        array[SECOND] = toInt(input.substr(pos2));
        getParsingFlags(config).bigHour = true;
    });
    addParseToken('Hmm', function (input, array, config) {
        var pos = input.length - 2;
        array[HOUR] = toInt(input.substr(0, pos));
        array[MINUTE] = toInt(input.substr(pos));
    });
    addParseToken('Hmmss', function (input, array, config) {
        var pos1 = input.length - 4;
        var pos2 = input.length - 2;
        array[HOUR] = toInt(input.substr(0, pos1));
        array[MINUTE] = toInt(input.substr(pos1, 2));
        array[SECOND] = toInt(input.substr(pos2));
    });

    // LOCALES

    function localeIsPM (input) {
        // IE8 Quirks Mode & IE7 Standards Mode do not allow accessing strings like arrays
        // Using charAt should be more compatible.
        return ((input + '').toLowerCase().charAt(0) === 'p');
    }

    var defaultLocaleMeridiemParse = /[ap]\.?m?\.?/i;
    function localeMeridiem (hours, minutes, isLower) {
        if (hours > 11) {
            return isLower ? 'pm' : 'PM';
        } else {
            return isLower ? 'am' : 'AM';
        }
    }


    // MOMENTS

    // Setting the hour should keep the time, because the user explicitly
    // specified which hour they want. So trying to maintain the same hour (in
    // a new timezone) makes sense. Adding/subtracting hours does not follow
    // this rule.
    var getSetHour = makeGetSet('Hours', true);

    var baseConfig = {
        calendar: defaultCalendar,
        longDateFormat: defaultLongDateFormat,
        invalidDate: defaultInvalidDate,
        ordinal: defaultOrdinal,
        dayOfMonthOrdinalParse: defaultDayOfMonthOrdinalParse,
        relativeTime: defaultRelativeTime,

        months: defaultLocaleMonths,
        monthsShort: defaultLocaleMonthsShort,

        week: defaultLocaleWeek,

        weekdays: defaultLocaleWeekdays,
        weekdaysMin: defaultLocaleWeekdaysMin,
        weekdaysShort: defaultLocaleWeekdaysShort,

        meridiemParse: defaultLocaleMeridiemParse
    };

    // internal storage for locale config files
    var locales = {};
    var localeFamilies = {};
    var globalLocale;

    function normalizeLocale(key) {
        return key ? key.toLowerCase().replace('_', '-') : key;
    }

    // pick the locale from the array
    // try ['en-au', 'en-gb'] as 'en-au', 'en-gb', 'en', as in move through the list trying each
    // substring from most specific to least, but move to the next array item if it's a more specific variant than the current root
    function chooseLocale(names) {
        var i = 0, j, next, locale, split;

        while (i < names.length) {
            split = normalizeLocale(names[i]).split('-');
            j = split.length;
            next = normalizeLocale(names[i + 1]);
            next = next ? next.split('-') : null;
            while (j > 0) {
                locale = loadLocale(split.slice(0, j).join('-'));
                if (locale) {
                    return locale;
                }
                if (next && next.length >= j && compareArrays(split, next, true) >= j - 1) {
                    //the next array item is better than a shallower substring of this one
                    break;
                }
                j--;
            }
            i++;
        }
        return globalLocale;
    }

    function loadLocale(name) {
        var oldLocale = null;
        // TODO: Find a better way to register and load all the locales in Node
        if (!locales[name] && (typeof module !== 'undefined') &&
                module && module.exports) {
            try {
                oldLocale = globalLocale._abbr;
                var aliasedRequire = require;
                aliasedRequire('./locale/' + name);
                getSetGlobalLocale(oldLocale);
            } catch (e) {}
        }
        return locales[name];
    }

    // This function will load locale and then set the global locale.  If
    // no arguments are passed in, it will simply return the current global
    // locale key.
    function getSetGlobalLocale (key, values) {
        var data;
        if (key) {
            if (isUndefined(values)) {
                data = getLocale(key);
            }
            else {
                data = defineLocale(key, values);
            }

            if (data) {
                // moment.duration._locale = moment._locale = data;
                globalLocale = data;
            }
            else {
                if ((typeof console !==  'undefined') && console.warn) {
                    //warn user if arguments are passed but the locale could not be set
                    console.warn('Locale ' + key +  ' not found. Did you forget to load it?');
                }
            }
        }

        return globalLocale._abbr;
    }

    function defineLocale (name, config) {
        if (config !== null) {
            var locale, parentConfig = baseConfig;
            config.abbr = name;
            if (locales[name] != null) {
                deprecateSimple('defineLocaleOverride',
                        'use moment.updateLocale(localeName, config) to change ' +
                        'an existing locale. moment.defineLocale(localeName, ' +
                        'config) should only be used for creating a new locale ' +
                        'See http://momentjs.com/guides/#/warnings/define-locale/ for more info.');
                parentConfig = locales[name]._config;
            } else if (config.parentLocale != null) {
                if (locales[config.parentLocale] != null) {
                    parentConfig = locales[config.parentLocale]._config;
                } else {
                    locale = loadLocale(config.parentLocale);
                    if (locale != null) {
                        parentConfig = locale._config;
                    } else {
                        if (!localeFamilies[config.parentLocale]) {
                            localeFamilies[config.parentLocale] = [];
                        }
                        localeFamilies[config.parentLocale].push({
                            name: name,
                            config: config
                        });
                        return null;
                    }
                }
            }
            locales[name] = new Locale(mergeConfigs(parentConfig, config));

            if (localeFamilies[name]) {
                localeFamilies[name].forEach(function (x) {
                    defineLocale(x.name, x.config);
                });
            }

            // backwards compat for now: also set the locale
            // make sure we set the locale AFTER all child locales have been
            // created, so we won't end up with the child locale set.
            getSetGlobalLocale(name);


            return locales[name];
        } else {
            // useful for testing
            delete locales[name];
            return null;
        }
    }

    function updateLocale(name, config) {
        if (config != null) {
            var locale, tmpLocale, parentConfig = baseConfig;
            // MERGE
            tmpLocale = loadLocale(name);
            if (tmpLocale != null) {
                parentConfig = tmpLocale._config;
            }
            config = mergeConfigs(parentConfig, config);
            locale = new Locale(config);
            locale.parentLocale = locales[name];
            locales[name] = locale;

            // backwards compat for now: also set the locale
            getSetGlobalLocale(name);
        } else {
            // pass null for config to unupdate, useful for tests
            if (locales[name] != null) {
                if (locales[name].parentLocale != null) {
                    locales[name] = locales[name].parentLocale;
                } else if (locales[name] != null) {
                    delete locales[name];
                }
            }
        }
        return locales[name];
    }

    // returns locale data
    function getLocale (key) {
        var locale;

        if (key && key._locale && key._locale._abbr) {
            key = key._locale._abbr;
        }

        if (!key) {
            return globalLocale;
        }

        if (!isArray(key)) {
            //short-circuit everything else
            locale = loadLocale(key);
            if (locale) {
                return locale;
            }
            key = [key];
        }

        return chooseLocale(key);
    }

    function listLocales() {
        return keys(locales);
    }

    function checkOverflow (m) {
        var overflow;
        var a = m._a;

        if (a && getParsingFlags(m).overflow === -2) {
            overflow =
                a[MONTH]       < 0 || a[MONTH]       > 11  ? MONTH :
                a[DATE]        < 1 || a[DATE]        > daysInMonth(a[YEAR], a[MONTH]) ? DATE :
                a[HOUR]        < 0 || a[HOUR]        > 24 || (a[HOUR] === 24 && (a[MINUTE] !== 0 || a[SECOND] !== 0 || a[MILLISECOND] !== 0)) ? HOUR :
                a[MINUTE]      < 0 || a[MINUTE]      > 59  ? MINUTE :
                a[SECOND]      < 0 || a[SECOND]      > 59  ? SECOND :
                a[MILLISECOND] < 0 || a[MILLISECOND] > 999 ? MILLISECOND :
                -1;

            if (getParsingFlags(m)._overflowDayOfYear && (overflow < YEAR || overflow > DATE)) {
                overflow = DATE;
            }
            if (getParsingFlags(m)._overflowWeeks && overflow === -1) {
                overflow = WEEK;
            }
            if (getParsingFlags(m)._overflowWeekday && overflow === -1) {
                overflow = WEEKDAY;
            }

            getParsingFlags(m).overflow = overflow;
        }

        return m;
    }

    // Pick the first defined of two or three arguments.
    function defaults(a, b, c) {
        if (a != null) {
            return a;
        }
        if (b != null) {
            return b;
        }
        return c;
    }

    function currentDateArray(config) {
        // hooks is actually the exported moment object
        var nowValue = new Date(hooks.now());
        if (config._useUTC) {
            return [nowValue.getUTCFullYear(), nowValue.getUTCMonth(), nowValue.getUTCDate()];
        }
        return [nowValue.getFullYear(), nowValue.getMonth(), nowValue.getDate()];
    }

    // convert an array to a date.
    // the array should mirror the parameters below
    // note: all values past the year are optional and will default to the lowest possible value.
    // [year, month, day , hour, minute, second, millisecond]
    function configFromArray (config) {
        var i, date, input = [], currentDate, expectedWeekday, yearToUse;

        if (config._d) {
            return;
        }

        currentDate = currentDateArray(config);

        //compute day of the year from weeks and weekdays
        if (config._w && config._a[DATE] == null && config._a[MONTH] == null) {
            dayOfYearFromWeekInfo(config);
        }

        //if the day of the year is set, figure out what it is
        if (config._dayOfYear != null) {
            yearToUse = defaults(config._a[YEAR], currentDate[YEAR]);

            if (config._dayOfYear > daysInYear(yearToUse) || config._dayOfYear === 0) {
                getParsingFlags(config)._overflowDayOfYear = true;
            }

            date = createUTCDate(yearToUse, 0, config._dayOfYear);
            config._a[MONTH] = date.getUTCMonth();
            config._a[DATE] = date.getUTCDate();
        }

        // Default to current date.
        // * if no year, month, day of month are given, default to today
        // * if day of month is given, default month and year
        // * if month is given, default only year
        // * if year is given, don't default anything
        for (i = 0; i < 3 && config._a[i] == null; ++i) {
            config._a[i] = input[i] = currentDate[i];
        }

        // Zero out whatever was not defaulted, including time
        for (; i < 7; i++) {
            config._a[i] = input[i] = (config._a[i] == null) ? (i === 2 ? 1 : 0) : config._a[i];
        }

        // Check for 24:00:00.000
        if (config._a[HOUR] === 24 &&
                config._a[MINUTE] === 0 &&
                config._a[SECOND] === 0 &&
                config._a[MILLISECOND] === 0) {
            config._nextDay = true;
            config._a[HOUR] = 0;
        }

        config._d = (config._useUTC ? createUTCDate : createDate).apply(null, input);
        expectedWeekday = config._useUTC ? config._d.getUTCDay() : config._d.getDay();

        // Apply timezone offset from input. The actual utcOffset can be changed
        // with parseZone.
        if (config._tzm != null) {
            config._d.setUTCMinutes(config._d.getUTCMinutes() - config._tzm);
        }

        if (config._nextDay) {
            config._a[HOUR] = 24;
        }

        // check for mismatching day of week
        if (config._w && typeof config._w.d !== 'undefined' && config._w.d !== expectedWeekday) {
            getParsingFlags(config).weekdayMismatch = true;
        }
    }

    function dayOfYearFromWeekInfo(config) {
        var w, weekYear, week, weekday, dow, doy, temp, weekdayOverflow;

        w = config._w;
        if (w.GG != null || w.W != null || w.E != null) {
            dow = 1;
            doy = 4;

            // TODO: We need to take the current isoWeekYear, but that depends on
            // how we interpret now (local, utc, fixed offset). So create
            // a now version of current config (take local/utc/offset flags, and
            // create now).
            weekYear = defaults(w.GG, config._a[YEAR], weekOfYear(createLocal(), 1, 4).year);
            week = defaults(w.W, 1);
            weekday = defaults(w.E, 1);
            if (weekday < 1 || weekday > 7) {
                weekdayOverflow = true;
            }
        } else {
            dow = config._locale._week.dow;
            doy = config._locale._week.doy;

            var curWeek = weekOfYear(createLocal(), dow, doy);

            weekYear = defaults(w.gg, config._a[YEAR], curWeek.year);

            // Default to current week.
            week = defaults(w.w, curWeek.week);

            if (w.d != null) {
                // weekday -- low day numbers are considered next week
                weekday = w.d;
                if (weekday < 0 || weekday > 6) {
                    weekdayOverflow = true;
                }
            } else if (w.e != null) {
                // local weekday -- counting starts from beginning of week
                weekday = w.e + dow;
                if (w.e < 0 || w.e > 6) {
                    weekdayOverflow = true;
                }
            } else {
                // default to beginning of week
                weekday = dow;
            }
        }
        if (week < 1 || week > weeksInYear(weekYear, dow, doy)) {
            getParsingFlags(config)._overflowWeeks = true;
        } else if (weekdayOverflow != null) {
            getParsingFlags(config)._overflowWeekday = true;
        } else {
            temp = dayOfYearFromWeeks(weekYear, week, weekday, dow, doy);
            config._a[YEAR] = temp.year;
            config._dayOfYear = temp.dayOfYear;
        }
    }

    // iso 8601 regex
    // 0000-00-00 0000-W00 or 0000-W00-0 + T + 00 or 00:00 or 00:00:00 or 00:00:00.000 + +00:00 or +0000 or +00)
    var extendedIsoRegex = /^\s*((?:[+-]\d{6}|\d{4})-(?:\d\d-\d\d|W\d\d-\d|W\d\d|\d\d\d|\d\d))(?:(T| )(\d\d(?::\d\d(?::\d\d(?:[.,]\d+)?)?)?)([\+\-]\d\d(?::?\d\d)?|\s*Z)?)?$/;
    var basicIsoRegex = /^\s*((?:[+-]\d{6}|\d{4})(?:\d\d\d\d|W\d\d\d|W\d\d|\d\d\d|\d\d))(?:(T| )(\d\d(?:\d\d(?:\d\d(?:[.,]\d+)?)?)?)([\+\-]\d\d(?::?\d\d)?|\s*Z)?)?$/;

    var tzRegex = /Z|[+-]\d\d(?::?\d\d)?/;

    var isoDates = [
        ['YYYYYY-MM-DD', /[+-]\d{6}-\d\d-\d\d/],
        ['YYYY-MM-DD', /\d{4}-\d\d-\d\d/],
        ['GGGG-[W]WW-E', /\d{4}-W\d\d-\d/],
        ['GGGG-[W]WW', /\d{4}-W\d\d/, false],
        ['YYYY-DDD', /\d{4}-\d{3}/],
        ['YYYY-MM', /\d{4}-\d\d/, false],
        ['YYYYYYMMDD', /[+-]\d{10}/],
        ['YYYYMMDD', /\d{8}/],
        // YYYYMM is NOT allowed by the standard
        ['GGGG[W]WWE', /\d{4}W\d{3}/],
        ['GGGG[W]WW', /\d{4}W\d{2}/, false],
        ['YYYYDDD', /\d{7}/]
    ];

    // iso time formats and regexes
    var isoTimes = [
        ['HH:mm:ss.SSSS', /\d\d:\d\d:\d\d\.\d+/],
        ['HH:mm:ss,SSSS', /\d\d:\d\d:\d\d,\d+/],
        ['HH:mm:ss', /\d\d:\d\d:\d\d/],
        ['HH:mm', /\d\d:\d\d/],
        ['HHmmss.SSSS', /\d\d\d\d\d\d\.\d+/],
        ['HHmmss,SSSS', /\d\d\d\d\d\d,\d+/],
        ['HHmmss', /\d\d\d\d\d\d/],
        ['HHmm', /\d\d\d\d/],
        ['HH', /\d\d/]
    ];

    var aspNetJsonRegex = /^\/?Date\((\-?\d+)/i;

    // date from iso format
    function configFromISO(config) {
        var i, l,
            string = config._i,
            match = extendedIsoRegex.exec(string) || basicIsoRegex.exec(string),
            allowTime, dateFormat, timeFormat, tzFormat;

        if (match) {
            getParsingFlags(config).iso = true;

            for (i = 0, l = isoDates.length; i < l; i++) {
                if (isoDates[i][1].exec(match[1])) {
                    dateFormat = isoDates[i][0];
                    allowTime = isoDates[i][2] !== false;
                    break;
                }
            }
            if (dateFormat == null) {
                config._isValid = false;
                return;
            }
            if (match[3]) {
                for (i = 0, l = isoTimes.length; i < l; i++) {
                    if (isoTimes[i][1].exec(match[3])) {
                        // match[2] should be 'T' or space
                        timeFormat = (match[2] || ' ') + isoTimes[i][0];
                        break;
                    }
                }
                if (timeFormat == null) {
                    config._isValid = false;
                    return;
                }
            }
            if (!allowTime && timeFormat != null) {
                config._isValid = false;
                return;
            }
            if (match[4]) {
                if (tzRegex.exec(match[4])) {
                    tzFormat = 'Z';
                } else {
                    config._isValid = false;
                    return;
                }
            }
            config._f = dateFormat + (timeFormat || '') + (tzFormat || '');
            configFromStringAndFormat(config);
        } else {
            config._isValid = false;
        }
    }

    // RFC 2822 regex: For details see https://tools.ietf.org/html/rfc2822#section-3.3
    var rfc2822 = /^(?:(Mon|Tue|Wed|Thu|Fri|Sat|Sun),?\s)?(\d{1,2})\s(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s(\d{2,4})\s(\d\d):(\d\d)(?::(\d\d))?\s(?:(UT|GMT|[ECMP][SD]T)|([Zz])|([+-]\d{4}))$/;

    function extractFromRFC2822Strings(yearStr, monthStr, dayStr, hourStr, minuteStr, secondStr) {
        var result = [
            untruncateYear(yearStr),
            defaultLocaleMonthsShort.indexOf(monthStr),
            parseInt(dayStr, 10),
            parseInt(hourStr, 10),
            parseInt(minuteStr, 10)
        ];

        if (secondStr) {
            result.push(parseInt(secondStr, 10));
        }

        return result;
    }

    function untruncateYear(yearStr) {
        var year = parseInt(yearStr, 10);
        if (year <= 49) {
            return 2000 + year;
        } else if (year <= 999) {
            return 1900 + year;
        }
        return year;
    }

    function preprocessRFC2822(s) {
        // Remove comments and folding whitespace and replace multiple-spaces with a single space
        return s.replace(/\([^)]*\)|[\n\t]/g, ' ').replace(/(\s\s+)/g, ' ').replace(/^\s\s*/, '').replace(/\s\s*$/, '');
    }

    function checkWeekday(weekdayStr, parsedInput, config) {
        if (weekdayStr) {
            // TODO: Replace the vanilla JS Date object with an indepentent day-of-week check.
            var weekdayProvided = defaultLocaleWeekdaysShort.indexOf(weekdayStr),
                weekdayActual = new Date(parsedInput[0], parsedInput[1], parsedInput[2]).getDay();
            if (weekdayProvided !== weekdayActual) {
                getParsingFlags(config).weekdayMismatch = true;
                config._isValid = false;
                return false;
            }
        }
        return true;
    }

    var obsOffsets = {
        UT: 0,
        GMT: 0,
        EDT: -4 * 60,
        EST: -5 * 60,
        CDT: -5 * 60,
        CST: -6 * 60,
        MDT: -6 * 60,
        MST: -7 * 60,
        PDT: -7 * 60,
        PST: -8 * 60
    };

    function calculateOffset(obsOffset, militaryOffset, numOffset) {
        if (obsOffset) {
            return obsOffsets[obsOffset];
        } else if (militaryOffset) {
            // the only allowed military tz is Z
            return 0;
        } else {
            var hm = parseInt(numOffset, 10);
            var m = hm % 100, h = (hm - m) / 100;
            return h * 60 + m;
        }
    }

    // date and time from ref 2822 format
    function configFromRFC2822(config) {
        var match = rfc2822.exec(preprocessRFC2822(config._i));
        if (match) {
            var parsedArray = extractFromRFC2822Strings(match[4], match[3], match[2], match[5], match[6], match[7]);
            if (!checkWeekday(match[1], parsedArray, config)) {
                return;
            }

            config._a = parsedArray;
            config._tzm = calculateOffset(match[8], match[9], match[10]);

            config._d = createUTCDate.apply(null, config._a);
            config._d.setUTCMinutes(config._d.getUTCMinutes() - config._tzm);

            getParsingFlags(config).rfc2822 = true;
        } else {
            config._isValid = false;
        }
    }

    // date from iso format or fallback
    function configFromString(config) {
        var matched = aspNetJsonRegex.exec(config._i);

        if (matched !== null) {
            config._d = new Date(+matched[1]);
            return;
        }

        configFromISO(config);
        if (config._isValid === false) {
            delete config._isValid;
        } else {
            return;
        }

        configFromRFC2822(config);
        if (config._isValid === false) {
            delete config._isValid;
        } else {
            return;
        }

        // Final attempt, use Input Fallback
        hooks.createFromInputFallback(config);
    }

    hooks.createFromInputFallback = deprecate(
        'value provided is not in a recognized RFC2822 or ISO format. moment construction falls back to js Date(), ' +
        'which is not reliable across all browsers and versions. Non RFC2822/ISO date formats are ' +
        'discouraged and will be removed in an upcoming major release. Please refer to ' +
        'http://momentjs.com/guides/#/warnings/js-date/ for more info.',
        function (config) {
            config._d = new Date(config._i + (config._useUTC ? ' UTC' : ''));
        }
    );

    // constant that refers to the ISO standard
    hooks.ISO_8601 = function () {};

    // constant that refers to the RFC 2822 form
    hooks.RFC_2822 = function () {};

    // date from string and format string
    function configFromStringAndFormat(config) {
        // TODO: Move this to another part of the creation flow to prevent circular deps
        if (config._f === hooks.ISO_8601) {
            configFromISO(config);
            return;
        }
        if (config._f === hooks.RFC_2822) {
            configFromRFC2822(config);
            return;
        }
        config._a = [];
        getParsingFlags(config).empty = true;

        // This array is used to make a Date, either with `new Date` or `Date.UTC`
        var string = '' + config._i,
            i, parsedInput, tokens, token, skipped,
            stringLength = string.length,
            totalParsedInputLength = 0;

        tokens = expandFormat(config._f, config._locale).match(formattingTokens) || [];

        for (i = 0; i < tokens.length; i++) {
            token = tokens[i];
            parsedInput = (string.match(getParseRegexForToken(token, config)) || [])[0];
            // console.log('token', token, 'parsedInput', parsedInput,
            //         'regex', getParseRegexForToken(token, config));
            if (parsedInput) {
                skipped = string.substr(0, string.indexOf(parsedInput));
                if (skipped.length > 0) {
                    getParsingFlags(config).unusedInput.push(skipped);
                }
                string = string.slice(string.indexOf(parsedInput) + parsedInput.length);
                totalParsedInputLength += parsedInput.length;
            }
            // don't parse if it's not a known token
            if (formatTokenFunctions[token]) {
                if (parsedInput) {
                    getParsingFlags(config).empty = false;
                }
                else {
                    getParsingFlags(config).unusedTokens.push(token);
                }
                addTimeToArrayFromToken(token, parsedInput, config);
            }
            else if (config._strict && !parsedInput) {
                getParsingFlags(config).unusedTokens.push(token);
            }
        }

        // add remaining unparsed input length to the string
        getParsingFlags(config).charsLeftOver = stringLength - totalParsedInputLength;
        if (string.length > 0) {
            getParsingFlags(config).unusedInput.push(string);
        }

        // clear _12h flag if hour is <= 12
        if (config._a[HOUR] <= 12 &&
            getParsingFlags(config).bigHour === true &&
            config._a[HOUR] > 0) {
            getParsingFlags(config).bigHour = undefined;
        }

        getParsingFlags(config).parsedDateParts = config._a.slice(0);
        getParsingFlags(config).meridiem = config._meridiem;
        // handle meridiem
        config._a[HOUR] = meridiemFixWrap(config._locale, config._a[HOUR], config._meridiem);

        configFromArray(config);
        checkOverflow(config);
    }


    function meridiemFixWrap (locale, hour, meridiem) {
        var isPm;

        if (meridiem == null) {
            // nothing to do
            return hour;
        }
        if (locale.meridiemHour != null) {
            return locale.meridiemHour(hour, meridiem);
        } else if (locale.isPM != null) {
            // Fallback
            isPm = locale.isPM(meridiem);
            if (isPm && hour < 12) {
                hour += 12;
            }
            if (!isPm && hour === 12) {
                hour = 0;
            }
            return hour;
        } else {
            // this is not supposed to happen
            return hour;
        }
    }

    // date from string and array of format strings
    function configFromStringAndArray(config) {
        var tempConfig,
            bestMoment,

            scoreToBeat,
            i,
            currentScore;

        if (config._f.length === 0) {
            getParsingFlags(config).invalidFormat = true;
            config._d = new Date(NaN);
            return;
        }

        for (i = 0; i < config._f.length; i++) {
            currentScore = 0;
            tempConfig = copyConfig({}, config);
            if (config._useUTC != null) {
                tempConfig._useUTC = config._useUTC;
            }
            tempConfig._f = config._f[i];
            configFromStringAndFormat(tempConfig);

            if (!isValid(tempConfig)) {
                continue;
            }

            // if there is any input that was not parsed add a penalty for that format
            currentScore += getParsingFlags(tempConfig).charsLeftOver;

            //or tokens
            currentScore += getParsingFlags(tempConfig).unusedTokens.length * 10;

            getParsingFlags(tempConfig).score = currentScore;

            if (scoreToBeat == null || currentScore < scoreToBeat) {
                scoreToBeat = currentScore;
                bestMoment = tempConfig;
            }
        }

        extend(config, bestMoment || tempConfig);
    }

    function configFromObject(config) {
        if (config._d) {
            return;
        }

        var i = normalizeObjectUnits(config._i);
        config._a = map([i.year, i.month, i.day || i.date, i.hour, i.minute, i.second, i.millisecond], function (obj) {
            return obj && parseInt(obj, 10);
        });

        configFromArray(config);
    }

    function createFromConfig (config) {
        var res = new Moment(checkOverflow(prepareConfig(config)));
        if (res._nextDay) {
            // Adding is smart enough around DST
            res.add(1, 'd');
            res._nextDay = undefined;
        }

        return res;
    }

    function prepareConfig (config) {
        var input = config._i,
            format = config._f;

        config._locale = config._locale || getLocale(config._l);

        if (input === null || (format === undefined && input === '')) {
            return createInvalid({nullInput: true});
        }

        if (typeof input === 'string') {
            config._i = input = config._locale.preparse(input);
        }

        if (isMoment(input)) {
            return new Moment(checkOverflow(input));
        } else if (isDate(input)) {
            config._d = input;
        } else if (isArray(format)) {
            configFromStringAndArray(config);
        } else if (format) {
            configFromStringAndFormat(config);
        }  else {
            configFromInput(config);
        }

        if (!isValid(config)) {
            config._d = null;
        }

        return config;
    }

    function configFromInput(config) {
        var input = config._i;
        if (isUndefined(input)) {
            config._d = new Date(hooks.now());
        } else if (isDate(input)) {
            config._d = new Date(input.valueOf());
        } else if (typeof input === 'string') {
            configFromString(config);
        } else if (isArray(input)) {
            config._a = map(input.slice(0), function (obj) {
                return parseInt(obj, 10);
            });
            configFromArray(config);
        } else if (isObject(input)) {
            configFromObject(config);
        } else if (isNumber(input)) {
            // from milliseconds
            config._d = new Date(input);
        } else {
            hooks.createFromInputFallback(config);
        }
    }

    function createLocalOrUTC (input, format, locale, strict, isUTC) {
        var c = {};

        if (locale === true || locale === false) {
            strict = locale;
            locale = undefined;
        }

        if ((isObject(input) && isObjectEmpty(input)) ||
                (isArray(input) && input.length === 0)) {
            input = undefined;
        }
        // object construction must be done this way.
        // https://github.com/moment/moment/issues/1423
        c._isAMomentObject = true;
        c._useUTC = c._isUTC = isUTC;
        c._l = locale;
        c._i = input;
        c._f = format;
        c._strict = strict;

        return createFromConfig(c);
    }

    function createLocal (input, format, locale, strict) {
        return createLocalOrUTC(input, format, locale, strict, false);
    }

    var prototypeMin = deprecate(
        'moment().min is deprecated, use moment.max instead. http://momentjs.com/guides/#/warnings/min-max/',
        function () {
            var other = createLocal.apply(null, arguments);
            if (this.isValid() && other.isValid()) {
                return other < this ? this : other;
            } else {
                return createInvalid();
            }
        }
    );

    var prototypeMax = deprecate(
        'moment().max is deprecated, use moment.min instead. http://momentjs.com/guides/#/warnings/min-max/',
        function () {
            var other = createLocal.apply(null, arguments);
            if (this.isValid() && other.isValid()) {
                return other > this ? this : other;
            } else {
                return createInvalid();
            }
        }
    );

    // Pick a moment m from moments so that m[fn](other) is true for all
    // other. This relies on the function fn to be transitive.
    //
    // moments should either be an array of moment objects or an array, whose
    // first element is an array of moment objects.
    function pickBy(fn, moments) {
        var res, i;
        if (moments.length === 1 && isArray(moments[0])) {
            moments = moments[0];
        }
        if (!moments.length) {
            return createLocal();
        }
        res = moments[0];
        for (i = 1; i < moments.length; ++i) {
            if (!moments[i].isValid() || moments[i][fn](res)) {
                res = moments[i];
            }
        }
        return res;
    }

    // TODO: Use [].sort instead?
    function min () {
        var args = [].slice.call(arguments, 0);

        return pickBy('isBefore', args);
    }

    function max () {
        var args = [].slice.call(arguments, 0);

        return pickBy('isAfter', args);
    }

    var now = function () {
        return Date.now ? Date.now() : +(new Date());
    };

    var ordering = ['year', 'quarter', 'month', 'week', 'day', 'hour', 'minute', 'second', 'millisecond'];

    function isDurationValid(m) {
        for (var key in m) {
            if (!(indexOf.call(ordering, key) !== -1 && (m[key] == null || !isNaN(m[key])))) {
                return false;
            }
        }

        var unitHasDecimal = false;
        for (var i = 0; i < ordering.length; ++i) {
            if (m[ordering[i]]) {
                if (unitHasDecimal) {
                    return false; // only allow non-integers for smallest unit
                }
                if (parseFloat(m[ordering[i]]) !== toInt(m[ordering[i]])) {
                    unitHasDecimal = true;
                }
            }
        }

        return true;
    }

    function isValid$1() {
        return this._isValid;
    }

    function createInvalid$1() {
        return createDuration(NaN);
    }

    function Duration (duration) {
        var normalizedInput = normalizeObjectUnits(duration),
            years = normalizedInput.year || 0,
            quarters = normalizedInput.quarter || 0,
            months = normalizedInput.month || 0,
            weeks = normalizedInput.week || normalizedInput.isoWeek || 0,
            days = normalizedInput.day || 0,
            hours = normalizedInput.hour || 0,
            minutes = normalizedInput.minute || 0,
            seconds = normalizedInput.second || 0,
            milliseconds = normalizedInput.millisecond || 0;

        this._isValid = isDurationValid(normalizedInput);

        // representation for dateAddRemove
        this._milliseconds = +milliseconds +
            seconds * 1e3 + // 1000
            minutes * 6e4 + // 1000 * 60
            hours * 1000 * 60 * 60; //using 1000 * 60 * 60 instead of 36e5 to avoid floating point rounding errors https://github.com/moment/moment/issues/2978
        // Because of dateAddRemove treats 24 hours as different from a
        // day when working around DST, we need to store them separately
        this._days = +days +
            weeks * 7;
        // It is impossible to translate months into days without knowing
        // which months you are are talking about, so we have to store
        // it separately.
        this._months = +months +
            quarters * 3 +
            years * 12;

        this._data = {};

        this._locale = getLocale();

        this._bubble();
    }

    function isDuration (obj) {
        return obj instanceof Duration;
    }

    function absRound (number) {
        if (number < 0) {
            return Math.round(-1 * number) * -1;
        } else {
            return Math.round(number);
        }
    }

    // FORMATTING

    function offset (token, separator) {
        addFormatToken(token, 0, 0, function () {
            var offset = this.utcOffset();
            var sign = '+';
            if (offset < 0) {
                offset = -offset;
                sign = '-';
            }
            return sign + zeroFill(~~(offset / 60), 2) + separator + zeroFill(~~(offset) % 60, 2);
        });
    }

    offset('Z', ':');
    offset('ZZ', '');

    // PARSING

    addRegexToken('Z',  matchShortOffset);
    addRegexToken('ZZ', matchShortOffset);
    addParseToken(['Z', 'ZZ'], function (input, array, config) {
        config._useUTC = true;
        config._tzm = offsetFromString(matchShortOffset, input);
    });

    // HELPERS

    // timezone chunker
    // '+10:00' > ['10',  '00']
    // '-1530'  > ['-15', '30']
    var chunkOffset = /([\+\-]|\d\d)/gi;

    function offsetFromString(matcher, string) {
        var matches = (string || '').match(matcher);

        if (matches === null) {
            return null;
        }

        var chunk   = matches[matches.length - 1] || [];
        var parts   = (chunk + '').match(chunkOffset) || ['-', 0, 0];
        var minutes = +(parts[1] * 60) + toInt(parts[2]);

        return minutes === 0 ?
          0 :
          parts[0] === '+' ? minutes : -minutes;
    }

    // Return a moment from input, that is local/utc/zone equivalent to model.
    function cloneWithOffset(input, model) {
        var res, diff;
        if (model._isUTC) {
            res = model.clone();
            diff = (isMoment(input) || isDate(input) ? input.valueOf() : createLocal(input).valueOf()) - res.valueOf();
            // Use low-level api, because this fn is low-level api.
            res._d.setTime(res._d.valueOf() + diff);
            hooks.updateOffset(res, false);
            return res;
        } else {
            return createLocal(input).local();
        }
    }

    function getDateOffset (m) {
        // On Firefox.24 Date#getTimezoneOffset returns a floating point.
        // https://github.com/moment/moment/pull/1871
        return -Math.round(m._d.getTimezoneOffset() / 15) * 15;
    }

    // HOOKS

    // This function will be called whenever a moment is mutated.
    // It is intended to keep the offset in sync with the timezone.
    hooks.updateOffset = function () {};

    // MOMENTS

    // keepLocalTime = true means only change the timezone, without
    // affecting the local hour. So 5:31:26 +0300 --[utcOffset(2, true)]-->
    // 5:31:26 +0200 It is possible that 5:31:26 doesn't exist with offset
    // +0200, so we adjust the time as needed, to be valid.
    //
    // Keeping the time actually adds/subtracts (one hour)
    // from the actual represented time. That is why we call updateOffset
    // a second time. In case it wants us to change the offset again
    // _changeInProgress == true case, then we have to adjust, because
    // there is no such time in the given timezone.
    function getSetOffset (input, keepLocalTime, keepMinutes) {
        var offset = this._offset || 0,
            localAdjust;
        if (!this.isValid()) {
            return input != null ? this : NaN;
        }
        if (input != null) {
            if (typeof input === 'string') {
                input = offsetFromString(matchShortOffset, input);
                if (input === null) {
                    return this;
                }
            } else if (Math.abs(input) < 16 && !keepMinutes) {
                input = input * 60;
            }
            if (!this._isUTC && keepLocalTime) {
                localAdjust = getDateOffset(this);
            }
            this._offset = input;
            this._isUTC = true;
            if (localAdjust != null) {
                this.add(localAdjust, 'm');
            }
            if (offset !== input) {
                if (!keepLocalTime || this._changeInProgress) {
                    addSubtract(this, createDuration(input - offset, 'm'), 1, false);
                } else if (!this._changeInProgress) {
                    this._changeInProgress = true;
                    hooks.updateOffset(this, true);
                    this._changeInProgress = null;
                }
            }
            return this;
        } else {
            return this._isUTC ? offset : getDateOffset(this);
        }
    }

    function getSetZone (input, keepLocalTime) {
        if (input != null) {
            if (typeof input !== 'string') {
                input = -input;
            }

            this.utcOffset(input, keepLocalTime);

            return this;
        } else {
            return -this.utcOffset();
        }
    }

    function setOffsetToUTC (keepLocalTime) {
        return this.utcOffset(0, keepLocalTime);
    }

    function setOffsetToLocal (keepLocalTime) {
        if (this._isUTC) {
            this.utcOffset(0, keepLocalTime);
            this._isUTC = false;

            if (keepLocalTime) {
                this.subtract(getDateOffset(this), 'm');
            }
        }
        return this;
    }

    function setOffsetToParsedOffset () {
        if (this._tzm != null) {
            this.utcOffset(this._tzm, false, true);
        } else if (typeof this._i === 'string') {
            var tZone = offsetFromString(matchOffset, this._i);
            if (tZone != null) {
                this.utcOffset(tZone);
            }
            else {
                this.utcOffset(0, true);
            }
        }
        return this;
    }

    function hasAlignedHourOffset (input) {
        if (!this.isValid()) {
            return false;
        }
        input = input ? createLocal(input).utcOffset() : 0;

        return (this.utcOffset() - input) % 60 === 0;
    }

    function isDaylightSavingTime () {
        return (
            this.utcOffset() > this.clone().month(0).utcOffset() ||
            this.utcOffset() > this.clone().month(5).utcOffset()
        );
    }

    function isDaylightSavingTimeShifted () {
        if (!isUndefined(this._isDSTShifted)) {
            return this._isDSTShifted;
        }

        var c = {};

        copyConfig(c, this);
        c = prepareConfig(c);

        if (c._a) {
            var other = c._isUTC ? createUTC(c._a) : createLocal(c._a);
            this._isDSTShifted = this.isValid() &&
                compareArrays(c._a, other.toArray()) > 0;
        } else {
            this._isDSTShifted = false;
        }

        return this._isDSTShifted;
    }

    function isLocal () {
        return this.isValid() ? !this._isUTC : false;
    }

    function isUtcOffset () {
        return this.isValid() ? this._isUTC : false;
    }

    function isUtc () {
        return this.isValid() ? this._isUTC && this._offset === 0 : false;
    }

    // ASP.NET json date format regex
    var aspNetRegex = /^(\-|\+)?(?:(\d*)[. ])?(\d+)\:(\d+)(?:\:(\d+)(\.\d*)?)?$/;

    // from http://docs.closure-library.googlecode.com/git/closure_goog_date_date.js.source.html
    // somewhat more in line with 4.4.3.2 2004 spec, but allows decimal anywhere
    // and further modified to allow for strings containing both week and day
    var isoRegex = /^(-|\+)?P(?:([-+]?[0-9,.]*)Y)?(?:([-+]?[0-9,.]*)M)?(?:([-+]?[0-9,.]*)W)?(?:([-+]?[0-9,.]*)D)?(?:T(?:([-+]?[0-9,.]*)H)?(?:([-+]?[0-9,.]*)M)?(?:([-+]?[0-9,.]*)S)?)?$/;

    function createDuration (input, key) {
        var duration = input,
            // matching against regexp is expensive, do it on demand
            match = null,
            sign,
            ret,
            diffRes;

        if (isDuration(input)) {
            duration = {
                ms : input._milliseconds,
                d  : input._days,
                M  : input._months
            };
        } else if (isNumber(input)) {
            duration = {};
            if (key) {
                duration[key] = input;
            } else {
                duration.milliseconds = input;
            }
        } else if (!!(match = aspNetRegex.exec(input))) {
            sign = (match[1] === '-') ? -1 : 1;
            duration = {
                y  : 0,
                d  : toInt(match[DATE])                         * sign,
                h  : toInt(match[HOUR])                         * sign,
                m  : toInt(match[MINUTE])                       * sign,
                s  : toInt(match[SECOND])                       * sign,
                ms : toInt(absRound(match[MILLISECOND] * 1000)) * sign // the millisecond decimal point is included in the match
            };
        } else if (!!(match = isoRegex.exec(input))) {
            sign = (match[1] === '-') ? -1 : 1;
            duration = {
                y : parseIso(match[2], sign),
                M : parseIso(match[3], sign),
                w : parseIso(match[4], sign),
                d : parseIso(match[5], sign),
                h : parseIso(match[6], sign),
                m : parseIso(match[7], sign),
                s : parseIso(match[8], sign)
            };
        } else if (duration == null) {// checks for null or undefined
            duration = {};
        } else if (typeof duration === 'object' && ('from' in duration || 'to' in duration)) {
            diffRes = momentsDifference(createLocal(duration.from), createLocal(duration.to));

            duration = {};
            duration.ms = diffRes.milliseconds;
            duration.M = diffRes.months;
        }

        ret = new Duration(duration);

        if (isDuration(input) && hasOwnProp(input, '_locale')) {
            ret._locale = input._locale;
        }

        return ret;
    }

    createDuration.fn = Duration.prototype;
    createDuration.invalid = createInvalid$1;

    function parseIso (inp, sign) {
        // We'd normally use ~~inp for this, but unfortunately it also
        // converts floats to ints.
        // inp may be undefined, so careful calling replace on it.
        var res = inp && parseFloat(inp.replace(',', '.'));
        // apply sign while we're at it
        return (isNaN(res) ? 0 : res) * sign;
    }

    function positiveMomentsDifference(base, other) {
        var res = {};

        res.months = other.month() - base.month() +
            (other.year() - base.year()) * 12;
        if (base.clone().add(res.months, 'M').isAfter(other)) {
            --res.months;
        }

        res.milliseconds = +other - +(base.clone().add(res.months, 'M'));

        return res;
    }

    function momentsDifference(base, other) {
        var res;
        if (!(base.isValid() && other.isValid())) {
            return {milliseconds: 0, months: 0};
        }

        other = cloneWithOffset(other, base);
        if (base.isBefore(other)) {
            res = positiveMomentsDifference(base, other);
        } else {
            res = positiveMomentsDifference(other, base);
            res.milliseconds = -res.milliseconds;
            res.months = -res.months;
        }

        return res;
    }

    // TODO: remove 'name' arg after deprecation is removed
    function createAdder(direction, name) {
        return function (val, period) {
            var dur, tmp;
            //invert the arguments, but complain about it
            if (period !== null && !isNaN(+period)) {
                deprecateSimple(name, 'moment().' + name  + '(period, number) is deprecated. Please use moment().' + name + '(number, period). ' +
                'See http://momentjs.com/guides/#/warnings/add-inverted-param/ for more info.');
                tmp = val; val = period; period = tmp;
            }

            val = typeof val === 'string' ? +val : val;
            dur = createDuration(val, period);
            addSubtract(this, dur, direction);
            return this;
        };
    }

    function addSubtract (mom, duration, isAdding, updateOffset) {
        var milliseconds = duration._milliseconds,
            days = absRound(duration._days),
            months = absRound(duration._months);

        if (!mom.isValid()) {
            // No op
            return;
        }

        updateOffset = updateOffset == null ? true : updateOffset;

        if (months) {
            setMonth(mom, get(mom, 'Month') + months * isAdding);
        }
        if (days) {
            set$1(mom, 'Date', get(mom, 'Date') + days * isAdding);
        }
        if (milliseconds) {
            mom._d.setTime(mom._d.valueOf() + milliseconds * isAdding);
        }
        if (updateOffset) {
            hooks.updateOffset(mom, days || months);
        }
    }

    var add      = createAdder(1, 'add');
    var subtract = createAdder(-1, 'subtract');

    function getCalendarFormat(myMoment, now) {
        var diff = myMoment.diff(now, 'days', true);
        return diff < -6 ? 'sameElse' :
                diff < -1 ? 'lastWeek' :
                diff < 0 ? 'lastDay' :
                diff < 1 ? 'sameDay' :
                diff < 2 ? 'nextDay' :
                diff < 7 ? 'nextWeek' : 'sameElse';
    }

    function calendar$1 (time, formats) {
        // We want to compare the start of today, vs this.
        // Getting start-of-today depends on whether we're local/utc/offset or not.
        var now = time || createLocal(),
            sod = cloneWithOffset(now, this).startOf('day'),
            format = hooks.calendarFormat(this, sod) || 'sameElse';

        var output = formats && (isFunction(formats[format]) ? formats[format].call(this, now) : formats[format]);

        return this.format(output || this.localeData().calendar(format, this, createLocal(now)));
    }

    function clone () {
        return new Moment(this);
    }

    function isAfter (input, units) {
        var localInput = isMoment(input) ? input : createLocal(input);
        if (!(this.isValid() && localInput.isValid())) {
            return false;
        }
        units = normalizeUnits(units) || 'millisecond';
        if (units === 'millisecond') {
            return this.valueOf() > localInput.valueOf();
        } else {
            return localInput.valueOf() < this.clone().startOf(units).valueOf();
        }
    }

    function isBefore (input, units) {
        var localInput = isMoment(input) ? input : createLocal(input);
        if (!(this.isValid() && localInput.isValid())) {
            return false;
        }
        units = normalizeUnits(units) || 'millisecond';
        if (units === 'millisecond') {
            return this.valueOf() < localInput.valueOf();
        } else {
            return this.clone().endOf(units).valueOf() < localInput.valueOf();
        }
    }

    function isBetween (from, to, units, inclusivity) {
        var localFrom = isMoment(from) ? from : createLocal(from),
            localTo = isMoment(to) ? to : createLocal(to);
        if (!(this.isValid() && localFrom.isValid() && localTo.isValid())) {
            return false;
        }
        inclusivity = inclusivity || '()';
        return (inclusivity[0] === '(' ? this.isAfter(localFrom, units) : !this.isBefore(localFrom, units)) &&
            (inclusivity[1] === ')' ? this.isBefore(localTo, units) : !this.isAfter(localTo, units));
    }

    function isSame (input, units) {
        var localInput = isMoment(input) ? input : createLocal(input),
            inputMs;
        if (!(this.isValid() && localInput.isValid())) {
            return false;
        }
        units = normalizeUnits(units) || 'millisecond';
        if (units === 'millisecond') {
            return this.valueOf() === localInput.valueOf();
        } else {
            inputMs = localInput.valueOf();
            return this.clone().startOf(units).valueOf() <= inputMs && inputMs <= this.clone().endOf(units).valueOf();
        }
    }

    function isSameOrAfter (input, units) {
        return this.isSame(input, units) || this.isAfter(input, units);
    }

    function isSameOrBefore (input, units) {
        return this.isSame(input, units) || this.isBefore(input, units);
    }

    function diff (input, units, asFloat) {
        var that,
            zoneDelta,
            output;

        if (!this.isValid()) {
            return NaN;
        }

        that = cloneWithOffset(input, this);

        if (!that.isValid()) {
            return NaN;
        }

        zoneDelta = (that.utcOffset() - this.utcOffset()) * 6e4;

        units = normalizeUnits(units);

        switch (units) {
            case 'year': output = monthDiff(this, that) / 12; break;
            case 'month': output = monthDiff(this, that); break;
            case 'quarter': output = monthDiff(this, that) / 3; break;
            case 'second': output = (this - that) / 1e3; break; // 1000
            case 'minute': output = (this - that) / 6e4; break; // 1000 * 60
            case 'hour': output = (this - that) / 36e5; break; // 1000 * 60 * 60
            case 'day': output = (this - that - zoneDelta) / 864e5; break; // 1000 * 60 * 60 * 24, negate dst
            case 'week': output = (this - that - zoneDelta) / 6048e5; break; // 1000 * 60 * 60 * 24 * 7, negate dst
            default: output = this - that;
        }

        return asFloat ? output : absFloor(output);
    }

    function monthDiff (a, b) {
        // difference in months
        var wholeMonthDiff = ((b.year() - a.year()) * 12) + (b.month() - a.month()),
            // b is in (anchor - 1 month, anchor + 1 month)
            anchor = a.clone().add(wholeMonthDiff, 'months'),
            anchor2, adjust;

        if (b - anchor < 0) {
            anchor2 = a.clone().add(wholeMonthDiff - 1, 'months');
            // linear across the month
            adjust = (b - anchor) / (anchor - anchor2);
        } else {
            anchor2 = a.clone().add(wholeMonthDiff + 1, 'months');
            // linear across the month
            adjust = (b - anchor) / (anchor2 - anchor);
        }

        //check for negative zero, return zero if negative zero
        return -(wholeMonthDiff + adjust) || 0;
    }

    hooks.defaultFormat = 'YYYY-MM-DDTHH:mm:ssZ';
    hooks.defaultFormatUtc = 'YYYY-MM-DDTHH:mm:ss[Z]';

    function toString () {
        return this.clone().locale('en').format('ddd MMM DD YYYY HH:mm:ss [GMT]ZZ');
    }

    function toISOString(keepOffset) {
        if (!this.isValid()) {
            return null;
        }
        var utc = keepOffset !== true;
        var m = utc ? this.clone().utc() : this;
        if (m.year() < 0 || m.year() > 9999) {
            return formatMoment(m, utc ? 'YYYYYY-MM-DD[T]HH:mm:ss.SSS[Z]' : 'YYYYYY-MM-DD[T]HH:mm:ss.SSSZ');
        }
        if (isFunction(Date.prototype.toISOString)) {
            // native implementation is ~50x faster, use it when we can
            if (utc) {
                return this.toDate().toISOString();
            } else {
                return new Date(this.valueOf() + this.utcOffset() * 60 * 1000).toISOString().replace('Z', formatMoment(m, 'Z'));
            }
        }
        return formatMoment(m, utc ? 'YYYY-MM-DD[T]HH:mm:ss.SSS[Z]' : 'YYYY-MM-DD[T]HH:mm:ss.SSSZ');
    }

    /**
     * Return a human readable representation of a moment that can
     * also be evaluated to get a new moment which is the same
     *
     * @link https://nodejs.org/dist/latest/docs/api/util.html#util_custom_inspect_function_on_objects
     */
    function inspect () {
        if (!this.isValid()) {
            return 'moment.invalid(/* ' + this._i + ' */)';
        }
        var func = 'moment';
        var zone = '';
        if (!this.isLocal()) {
            func = this.utcOffset() === 0 ? 'moment.utc' : 'moment.parseZone';
            zone = 'Z';
        }
        var prefix = '[' + func + '("]';
        var year = (0 <= this.year() && this.year() <= 9999) ? 'YYYY' : 'YYYYYY';
        var datetime = '-MM-DD[T]HH:mm:ss.SSS';
        var suffix = zone + '[")]';

        return this.format(prefix + year + datetime + suffix);
    }

    function format (inputString) {
        if (!inputString) {
            inputString = this.isUtc() ? hooks.defaultFormatUtc : hooks.defaultFormat;
        }
        var output = formatMoment(this, inputString);
        return this.localeData().postformat(output);
    }

    function from (time, withoutSuffix) {
        if (this.isValid() &&
                ((isMoment(time) && time.isValid()) ||
                 createLocal(time).isValid())) {
            return createDuration({to: this, from: time}).locale(this.locale()).humanize(!withoutSuffix);
        } else {
            return this.localeData().invalidDate();
        }
    }

    function fromNow (withoutSuffix) {
        return this.from(createLocal(), withoutSuffix);
    }

    function to (time, withoutSuffix) {
        if (this.isValid() &&
                ((isMoment(time) && time.isValid()) ||
                 createLocal(time).isValid())) {
            return createDuration({from: this, to: time}).locale(this.locale()).humanize(!withoutSuffix);
        } else {
            return this.localeData().invalidDate();
        }
    }

    function toNow (withoutSuffix) {
        return this.to(createLocal(), withoutSuffix);
    }

    // If passed a locale key, it will set the locale for this
    // instance.  Otherwise, it will return the locale configuration
    // variables for this instance.
    function locale (key) {
        var newLocaleData;

        if (key === undefined) {
            return this._locale._abbr;
        } else {
            newLocaleData = getLocale(key);
            if (newLocaleData != null) {
                this._locale = newLocaleData;
            }
            return this;
        }
    }

    var lang = deprecate(
        'moment().lang() is deprecated. Instead, use moment().localeData() to get the language configuration. Use moment().locale() to change languages.',
        function (key) {
            if (key === undefined) {
                return this.localeData();
            } else {
                return this.locale(key);
            }
        }
    );

    function localeData () {
        return this._locale;
    }

    var MS_PER_SECOND = 1000;
    var MS_PER_MINUTE = 60 * MS_PER_SECOND;
    var MS_PER_HOUR = 60 * MS_PER_MINUTE;
    var MS_PER_400_YEARS = (365 * 400 + 97) * 24 * MS_PER_HOUR;

    // actual modulo - handles negative numbers (for dates before 1970):
    function mod$1(dividend, divisor) {
        return (dividend % divisor + divisor) % divisor;
    }

    function localStartOfDate(y, m, d) {
        // the date constructor remaps years 0-99 to 1900-1999
        if (y < 100 && y >= 0) {
            // preserve leap years using a full 400 year cycle, then reset
            return new Date(y + 400, m, d) - MS_PER_400_YEARS;
        } else {
            return new Date(y, m, d).valueOf();
        }
    }

    function utcStartOfDate(y, m, d) {
        // Date.UTC remaps years 0-99 to 1900-1999
        if (y < 100 && y >= 0) {
            // preserve leap years using a full 400 year cycle, then reset
            return Date.UTC(y + 400, m, d) - MS_PER_400_YEARS;
        } else {
            return Date.UTC(y, m, d);
        }
    }

    function startOf (units) {
        var time;
        units = normalizeUnits(units);
        if (units === undefined || units === 'millisecond' || !this.isValid()) {
            return this;
        }

        var startOfDate = this._isUTC ? utcStartOfDate : localStartOfDate;

        switch (units) {
            case 'year':
                time = startOfDate(this.year(), 0, 1);
                break;
            case 'quarter':
                time = startOfDate(this.year(), this.month() - this.month() % 3, 1);
                break;
            case 'month':
                time = startOfDate(this.year(), this.month(), 1);
                break;
            case 'week':
                time = startOfDate(this.year(), this.month(), this.date() - this.weekday());
                break;
            case 'isoWeek':
                time = startOfDate(this.year(), this.month(), this.date() - (this.isoWeekday() - 1));
                break;
            case 'day':
            case 'date':
                time = startOfDate(this.year(), this.month(), this.date());
                break;
            case 'hour':
                time = this._d.valueOf();
                time -= mod$1(time + (this._isUTC ? 0 : this.utcOffset() * MS_PER_MINUTE), MS_PER_HOUR);
                break;
            case 'minute':
                time = this._d.valueOf();
                time -= mod$1(time, MS_PER_MINUTE);
                break;
            case 'second':
                time = this._d.valueOf();
                time -= mod$1(time, MS_PER_SECOND);
                break;
        }

        this._d.setTime(time);
        hooks.updateOffset(this, true);
        return this;
    }

    function endOf (units) {
        var time;
        units = normalizeUnits(units);
        if (units === undefined || units === 'millisecond' || !this.isValid()) {
            return this;
        }

        var startOfDate = this._isUTC ? utcStartOfDate : localStartOfDate;

        switch (units) {
            case 'year':
                time = startOfDate(this.year() + 1, 0, 1) - 1;
                break;
            case 'quarter':
                time = startOfDate(this.year(), this.month() - this.month() % 3 + 3, 1) - 1;
                break;
            case 'month':
                time = startOfDate(this.year(), this.month() + 1, 1) - 1;
                break;
            case 'week':
                time = startOfDate(this.year(), this.month(), this.date() - this.weekday() + 7) - 1;
                break;
            case 'isoWeek':
                time = startOfDate(this.year(), this.month(), this.date() - (this.isoWeekday() - 1) + 7) - 1;
                break;
            case 'day':
            case 'date':
                time = startOfDate(this.year(), this.month(), this.date() + 1) - 1;
                break;
            case 'hour':
                time = this._d.valueOf();
                time += MS_PER_HOUR - mod$1(time + (this._isUTC ? 0 : this.utcOffset() * MS_PER_MINUTE), MS_PER_HOUR) - 1;
                break;
            case 'minute':
                time = this._d.valueOf();
                time += MS_PER_MINUTE - mod$1(time, MS_PER_MINUTE) - 1;
                break;
            case 'second':
                time = this._d.valueOf();
                time += MS_PER_SECOND - mod$1(time, MS_PER_SECOND) - 1;
                break;
        }

        this._d.setTime(time);
        hooks.updateOffset(this, true);
        return this;
    }

    function valueOf () {
        return this._d.valueOf() - ((this._offset || 0) * 60000);
    }

    function unix () {
        return Math.floor(this.valueOf() / 1000);
    }

    function toDate () {
        return new Date(this.valueOf());
    }

    function toArray () {
        var m = this;
        return [m.year(), m.month(), m.date(), m.hour(), m.minute(), m.second(), m.millisecond()];
    }

    function toObject () {
        var m = this;
        return {
            years: m.year(),
            months: m.month(),
            date: m.date(),
            hours: m.hours(),
            minutes: m.minutes(),
            seconds: m.seconds(),
            milliseconds: m.milliseconds()
        };
    }

    function toJSON () {
        // new Date(NaN).toJSON() === null
        return this.isValid() ? this.toISOString() : null;
    }

    function isValid$2 () {
        return isValid(this);
    }

    function parsingFlags () {
        return extend({}, getParsingFlags(this));
    }

    function invalidAt () {
        return getParsingFlags(this).overflow;
    }

    function creationData() {
        return {
            input: this._i,
            format: this._f,
            locale: this._locale,
            isUTC: this._isUTC,
            strict: this._strict
        };
    }

    // FORMATTING

    addFormatToken(0, ['gg', 2], 0, function () {
        return this.weekYear() % 100;
    });

    addFormatToken(0, ['GG', 2], 0, function () {
        return this.isoWeekYear() % 100;
    });

    function addWeekYearFormatToken (token, getter) {
        addFormatToken(0, [token, token.length], 0, getter);
    }

    addWeekYearFormatToken('gggg',     'weekYear');
    addWeekYearFormatToken('ggggg',    'weekYear');
    addWeekYearFormatToken('GGGG',  'isoWeekYear');
    addWeekYearFormatToken('GGGGG', 'isoWeekYear');

    // ALIASES

    addUnitAlias('weekYear', 'gg');
    addUnitAlias('isoWeekYear', 'GG');

    // PRIORITY

    addUnitPriority('weekYear', 1);
    addUnitPriority('isoWeekYear', 1);


    // PARSING

    addRegexToken('G',      matchSigned);
    addRegexToken('g',      matchSigned);
    addRegexToken('GG',     match1to2, match2);
    addRegexToken('gg',     match1to2, match2);
    addRegexToken('GGGG',   match1to4, match4);
    addRegexToken('gggg',   match1to4, match4);
    addRegexToken('GGGGG',  match1to6, match6);
    addRegexToken('ggggg',  match1to6, match6);

    addWeekParseToken(['gggg', 'ggggg', 'GGGG', 'GGGGG'], function (input, week, config, token) {
        week[token.substr(0, 2)] = toInt(input);
    });

    addWeekParseToken(['gg', 'GG'], function (input, week, config, token) {
        week[token] = hooks.parseTwoDigitYear(input);
    });

    // MOMENTS

    function getSetWeekYear (input) {
        return getSetWeekYearHelper.call(this,
                input,
                this.week(),
                this.weekday(),
                this.localeData()._week.dow,
                this.localeData()._week.doy);
    }

    function getSetISOWeekYear (input) {
        return getSetWeekYearHelper.call(this,
                input, this.isoWeek(), this.isoWeekday(), 1, 4);
    }

    function getISOWeeksInYear () {
        return weeksInYear(this.year(), 1, 4);
    }

    function getWeeksInYear () {
        var weekInfo = this.localeData()._week;
        return weeksInYear(this.year(), weekInfo.dow, weekInfo.doy);
    }

    function getSetWeekYearHelper(input, week, weekday, dow, doy) {
        var weeksTarget;
        if (input == null) {
            return weekOfYear(this, dow, doy).year;
        } else {
            weeksTarget = weeksInYear(input, dow, doy);
            if (week > weeksTarget) {
                week = weeksTarget;
            }
            return setWeekAll.call(this, input, week, weekday, dow, doy);
        }
    }

    function setWeekAll(weekYear, week, weekday, dow, doy) {
        var dayOfYearData = dayOfYearFromWeeks(weekYear, week, weekday, dow, doy),
            date = createUTCDate(dayOfYearData.year, 0, dayOfYearData.dayOfYear);

        this.year(date.getUTCFullYear());
        this.month(date.getUTCMonth());
        this.date(date.getUTCDate());
        return this;
    }

    // FORMATTING

    addFormatToken('Q', 0, 'Qo', 'quarter');

    // ALIASES

    addUnitAlias('quarter', 'Q');

    // PRIORITY

    addUnitPriority('quarter', 7);

    // PARSING

    addRegexToken('Q', match1);
    addParseToken('Q', function (input, array) {
        array[MONTH] = (toInt(input) - 1) * 3;
    });

    // MOMENTS

    function getSetQuarter (input) {
        return input == null ? Math.ceil((this.month() + 1) / 3) : this.month((input - 1) * 3 + this.month() % 3);
    }

    // FORMATTING

    addFormatToken('D', ['DD', 2], 'Do', 'date');

    // ALIASES

    addUnitAlias('date', 'D');

    // PRIORITY
    addUnitPriority('date', 9);

    // PARSING

    addRegexToken('D',  match1to2);
    addRegexToken('DD', match1to2, match2);
    addRegexToken('Do', function (isStrict, locale) {
        // TODO: Remove "ordinalParse" fallback in next major release.
        return isStrict ?
          (locale._dayOfMonthOrdinalParse || locale._ordinalParse) :
          locale._dayOfMonthOrdinalParseLenient;
    });

    addParseToken(['D', 'DD'], DATE);
    addParseToken('Do', function (input, array) {
        array[DATE] = toInt(input.match(match1to2)[0]);
    });

    // MOMENTS

    var getSetDayOfMonth = makeGetSet('Date', true);

    // FORMATTING

    addFormatToken('DDD', ['DDDD', 3], 'DDDo', 'dayOfYear');

    // ALIASES

    addUnitAlias('dayOfYear', 'DDD');

    // PRIORITY
    addUnitPriority('dayOfYear', 4);

    // PARSING

    addRegexToken('DDD',  match1to3);
    addRegexToken('DDDD', match3);
    addParseToken(['DDD', 'DDDD'], function (input, array, config) {
        config._dayOfYear = toInt(input);
    });

    // HELPERS

    // MOMENTS

    function getSetDayOfYear (input) {
        var dayOfYear = Math.round((this.clone().startOf('day') - this.clone().startOf('year')) / 864e5) + 1;
        return input == null ? dayOfYear : this.add((input - dayOfYear), 'd');
    }

    // FORMATTING

    addFormatToken('m', ['mm', 2], 0, 'minute');

    // ALIASES

    addUnitAlias('minute', 'm');

    // PRIORITY

    addUnitPriority('minute', 14);

    // PARSING

    addRegexToken('m',  match1to2);
    addRegexToken('mm', match1to2, match2);
    addParseToken(['m', 'mm'], MINUTE);

    // MOMENTS

    var getSetMinute = makeGetSet('Minutes', false);

    // FORMATTING

    addFormatToken('s', ['ss', 2], 0, 'second');

    // ALIASES

    addUnitAlias('second', 's');

    // PRIORITY

    addUnitPriority('second', 15);

    // PARSING

    addRegexToken('s',  match1to2);
    addRegexToken('ss', match1to2, match2);
    addParseToken(['s', 'ss'], SECOND);

    // MOMENTS

    var getSetSecond = makeGetSet('Seconds', false);

    // FORMATTING

    addFormatToken('S', 0, 0, function () {
        return ~~(this.millisecond() / 100);
    });

    addFormatToken(0, ['SS', 2], 0, function () {
        return ~~(this.millisecond() / 10);
    });

    addFormatToken(0, ['SSS', 3], 0, 'millisecond');
    addFormatToken(0, ['SSSS', 4], 0, function () {
        return this.millisecond() * 10;
    });
    addFormatToken(0, ['SSSSS', 5], 0, function () {
        return this.millisecond() * 100;
    });
    addFormatToken(0, ['SSSSSS', 6], 0, function () {
        return this.millisecond() * 1000;
    });
    addFormatToken(0, ['SSSSSSS', 7], 0, function () {
        return this.millisecond() * 10000;
    });
    addFormatToken(0, ['SSSSSSSS', 8], 0, function () {
        return this.millisecond() * 100000;
    });
    addFormatToken(0, ['SSSSSSSSS', 9], 0, function () {
        return this.millisecond() * 1000000;
    });


    // ALIASES

    addUnitAlias('millisecond', 'ms');

    // PRIORITY

    addUnitPriority('millisecond', 16);

    // PARSING

    addRegexToken('S',    match1to3, match1);
    addRegexToken('SS',   match1to3, match2);
    addRegexToken('SSS',  match1to3, match3);

    var token;
    for (token = 'SSSS'; token.length <= 9; token += 'S') {
        addRegexToken(token, matchUnsigned);
    }

    function parseMs(input, array) {
        array[MILLISECOND] = toInt(('0.' + input) * 1000);
    }

    for (token = 'S'; token.length <= 9; token += 'S') {
        addParseToken(token, parseMs);
    }
    // MOMENTS

    var getSetMillisecond = makeGetSet('Milliseconds', false);

    // FORMATTING

    addFormatToken('z',  0, 0, 'zoneAbbr');
    addFormatToken('zz', 0, 0, 'zoneName');

    // MOMENTS

    function getZoneAbbr () {
        return this._isUTC ? 'UTC' : '';
    }

    function getZoneName () {
        return this._isUTC ? 'Coordinated Universal Time' : '';
    }

    var proto = Moment.prototype;

    proto.add               = add;
    proto.calendar          = calendar$1;
    proto.clone             = clone;
    proto.diff              = diff;
    proto.endOf             = endOf;
    proto.format            = format;
    proto.from              = from;
    proto.fromNow           = fromNow;
    proto.to                = to;
    proto.toNow             = toNow;
    proto.get               = stringGet;
    proto.invalidAt         = invalidAt;
    proto.isAfter           = isAfter;
    proto.isBefore          = isBefore;
    proto.isBetween         = isBetween;
    proto.isSame            = isSame;
    proto.isSameOrAfter     = isSameOrAfter;
    proto.isSameOrBefore    = isSameOrBefore;
    proto.isValid           = isValid$2;
    proto.lang              = lang;
    proto.locale            = locale;
    proto.localeData        = localeData;
    proto.max               = prototypeMax;
    proto.min               = prototypeMin;
    proto.parsingFlags      = parsingFlags;
    proto.set               = stringSet;
    proto.startOf           = startOf;
    proto.subtract          = subtract;
    proto.toArray           = toArray;
    proto.toObject          = toObject;
    proto.toDate            = toDate;
    proto.toISOString       = toISOString;
    proto.inspect           = inspect;
    proto.toJSON            = toJSON;
    proto.toString          = toString;
    proto.unix              = unix;
    proto.valueOf           = valueOf;
    proto.creationData      = creationData;
    proto.year       = getSetYear;
    proto.isLeapYear = getIsLeapYear;
    proto.weekYear    = getSetWeekYear;
    proto.isoWeekYear = getSetISOWeekYear;
    proto.quarter = proto.quarters = getSetQuarter;
    proto.month       = getSetMonth;
    proto.daysInMonth = getDaysInMonth;
    proto.week           = proto.weeks        = getSetWeek;
    proto.isoWeek        = proto.isoWeeks     = getSetISOWeek;
    proto.weeksInYear    = getWeeksInYear;
    proto.isoWeeksInYear = getISOWeeksInYear;
    proto.date       = getSetDayOfMonth;
    proto.day        = proto.days             = getSetDayOfWeek;
    proto.weekday    = getSetLocaleDayOfWeek;
    proto.isoWeekday = getSetISODayOfWeek;
    proto.dayOfYear  = getSetDayOfYear;
    proto.hour = proto.hours = getSetHour;
    proto.minute = proto.minutes = getSetMinute;
    proto.second = proto.seconds = getSetSecond;
    proto.millisecond = proto.milliseconds = getSetMillisecond;
    proto.utcOffset            = getSetOffset;
    proto.utc                  = setOffsetToUTC;
    proto.local                = setOffsetToLocal;
    proto.parseZone            = setOffsetToParsedOffset;
    proto.hasAlignedHourOffset = hasAlignedHourOffset;
    proto.isDST                = isDaylightSavingTime;
    proto.isLocal              = isLocal;
    proto.isUtcOffset          = isUtcOffset;
    proto.isUtc                = isUtc;
    proto.isUTC                = isUtc;
    proto.zoneAbbr = getZoneAbbr;
    proto.zoneName = getZoneName;
    proto.dates  = deprecate('dates accessor is deprecated. Use date instead.', getSetDayOfMonth);
    proto.months = deprecate('months accessor is deprecated. Use month instead', getSetMonth);
    proto.years  = deprecate('years accessor is deprecated. Use year instead', getSetYear);
    proto.zone   = deprecate('moment().zone is deprecated, use moment().utcOffset instead. http://momentjs.com/guides/#/warnings/zone/', getSetZone);
    proto.isDSTShifted = deprecate('isDSTShifted is deprecated. See http://momentjs.com/guides/#/warnings/dst-shifted/ for more information', isDaylightSavingTimeShifted);

    function createUnix (input) {
        return createLocal(input * 1000);
    }

    function createInZone () {
        return createLocal.apply(null, arguments).parseZone();
    }

    function preParsePostFormat (string) {
        return string;
    }

    var proto$1 = Locale.prototype;

    proto$1.calendar        = calendar;
    proto$1.longDateFormat  = longDateFormat;
    proto$1.invalidDate     = invalidDate;
    proto$1.ordinal         = ordinal;
    proto$1.preparse        = preParsePostFormat;
    proto$1.postformat      = preParsePostFormat;
    proto$1.relativeTime    = relativeTime;
    proto$1.pastFuture      = pastFuture;
    proto$1.set             = set;

    proto$1.months            =        localeMonths;
    proto$1.monthsShort       =        localeMonthsShort;
    proto$1.monthsParse       =        localeMonthsParse;
    proto$1.monthsRegex       = monthsRegex;
    proto$1.monthsShortRegex  = monthsShortRegex;
    proto$1.week = localeWeek;
    proto$1.firstDayOfYear = localeFirstDayOfYear;
    proto$1.firstDayOfWeek = localeFirstDayOfWeek;

    proto$1.weekdays       =        localeWeekdays;
    proto$1.weekdaysMin    =        localeWeekdaysMin;
    proto$1.weekdaysShort  =        localeWeekdaysShort;
    proto$1.weekdaysParse  =        localeWeekdaysParse;

    proto$1.weekdaysRegex       =        weekdaysRegex;
    proto$1.weekdaysShortRegex  =        weekdaysShortRegex;
    proto$1.weekdaysMinRegex    =        weekdaysMinRegex;

    proto$1.isPM = localeIsPM;
    proto$1.meridiem = localeMeridiem;

    function get$1 (format, index, field, setter) {
        var locale = getLocale();
        var utc = createUTC().set(setter, index);
        return locale[field](utc, format);
    }

    function listMonthsImpl (format, index, field) {
        if (isNumber(format)) {
            index = format;
            format = undefined;
        }

        format = format || '';

        if (index != null) {
            return get$1(format, index, field, 'month');
        }

        var i;
        var out = [];
        for (i = 0; i < 12; i++) {
            out[i] = get$1(format, i, field, 'month');
        }
        return out;
    }

    // ()
    // (5)
    // (fmt, 5)
    // (fmt)
    // (true)
    // (true, 5)
    // (true, fmt, 5)
    // (true, fmt)
    function listWeekdaysImpl (localeSorted, format, index, field) {
        if (typeof localeSorted === 'boolean') {
            if (isNumber(format)) {
                index = format;
                format = undefined;
            }

            format = format || '';
        } else {
            format = localeSorted;
            index = format;
            localeSorted = false;

            if (isNumber(format)) {
                index = format;
                format = undefined;
            }

            format = format || '';
        }

        var locale = getLocale(),
            shift = localeSorted ? locale._week.dow : 0;

        if (index != null) {
            return get$1(format, (index + shift) % 7, field, 'day');
        }

        var i;
        var out = [];
        for (i = 0; i < 7; i++) {
            out[i] = get$1(format, (i + shift) % 7, field, 'day');
        }
        return out;
    }

    function listMonths (format, index) {
        return listMonthsImpl(format, index, 'months');
    }

    function listMonthsShort (format, index) {
        return listMonthsImpl(format, index, 'monthsShort');
    }

    function listWeekdays (localeSorted, format, index) {
        return listWeekdaysImpl(localeSorted, format, index, 'weekdays');
    }

    function listWeekdaysShort (localeSorted, format, index) {
        return listWeekdaysImpl(localeSorted, format, index, 'weekdaysShort');
    }

    function listWeekdaysMin (localeSorted, format, index) {
        return listWeekdaysImpl(localeSorted, format, index, 'weekdaysMin');
    }

    getSetGlobalLocale('en', {
        dayOfMonthOrdinalParse: /\d{1,2}(th|st|nd|rd)/,
        ordinal : function (number) {
            var b = number % 10,
                output = (toInt(number % 100 / 10) === 1) ? 'th' :
                (b === 1) ? 'st' :
                (b === 2) ? 'nd' :
                (b === 3) ? 'rd' : 'th';
            return number + output;
        }
    });

    // Side effect imports

    hooks.lang = deprecate('moment.lang is deprecated. Use moment.locale instead.', getSetGlobalLocale);
    hooks.langData = deprecate('moment.langData is deprecated. Use moment.localeData instead.', getLocale);

    var mathAbs = Math.abs;

    function abs () {
        var data           = this._data;

        this._milliseconds = mathAbs(this._milliseconds);
        this._days         = mathAbs(this._days);
        this._months       = mathAbs(this._months);

        data.milliseconds  = mathAbs(data.milliseconds);
        data.seconds       = mathAbs(data.seconds);
        data.minutes       = mathAbs(data.minutes);
        data.hours         = mathAbs(data.hours);
        data.months        = mathAbs(data.months);
        data.years         = mathAbs(data.years);

        return this;
    }

    function addSubtract$1 (duration, input, value, direction) {
        var other = createDuration(input, value);

        duration._milliseconds += direction * other._milliseconds;
        duration._days         += direction * other._days;
        duration._months       += direction * other._months;

        return duration._bubble();
    }

    // supports only 2.0-style add(1, 's') or add(duration)
    function add$1 (input, value) {
        return addSubtract$1(this, input, value, 1);
    }

    // supports only 2.0-style subtract(1, 's') or subtract(duration)
    function subtract$1 (input, value) {
        return addSubtract$1(this, input, value, -1);
    }

    function absCeil (number) {
        if (number < 0) {
            return Math.floor(number);
        } else {
            return Math.ceil(number);
        }
    }

    function bubble () {
        var milliseconds = this._milliseconds;
        var days         = this._days;
        var months       = this._months;
        var data         = this._data;
        var seconds, minutes, hours, years, monthsFromDays;

        // if we have a mix of positive and negative values, bubble down first
        // check: https://github.com/moment/moment/issues/2166
        if (!((milliseconds >= 0 && days >= 0 && months >= 0) ||
                (milliseconds <= 0 && days <= 0 && months <= 0))) {
            milliseconds += absCeil(monthsToDays(months) + days) * 864e5;
            days = 0;
            months = 0;
        }

        // The following code bubbles up values, see the tests for
        // examples of what that means.
        data.milliseconds = milliseconds % 1000;

        seconds           = absFloor(milliseconds / 1000);
        data.seconds      = seconds % 60;

        minutes           = absFloor(seconds / 60);
        data.minutes      = minutes % 60;

        hours             = absFloor(minutes / 60);
        data.hours        = hours % 24;

        days += absFloor(hours / 24);

        // convert days to months
        monthsFromDays = absFloor(daysToMonths(days));
        months += monthsFromDays;
        days -= absCeil(monthsToDays(monthsFromDays));

        // 12 months -> 1 year
        years = absFloor(months / 12);
        months %= 12;

        data.days   = days;
        data.months = months;
        data.years  = years;

        return this;
    }

    function daysToMonths (days) {
        // 400 years have 146097 days (taking into account leap year rules)
        // 400 years have 12 months === 4800
        return days * 4800 / 146097;
    }

    function monthsToDays (months) {
        // the reverse of daysToMonths
        return months * 146097 / 4800;
    }

    function as (units) {
        if (!this.isValid()) {
            return NaN;
        }
        var days;
        var months;
        var milliseconds = this._milliseconds;

        units = normalizeUnits(units);

        if (units === 'month' || units === 'quarter' || units === 'year') {
            days = this._days + milliseconds / 864e5;
            months = this._months + daysToMonths(days);
            switch (units) {
                case 'month':   return months;
                case 'quarter': return months / 3;
                case 'year':    return months / 12;
            }
        } else {
            // handle milliseconds separately because of floating point math errors (issue #1867)
            days = this._days + Math.round(monthsToDays(this._months));
            switch (units) {
                case 'week'   : return days / 7     + milliseconds / 6048e5;
                case 'day'    : return days         + milliseconds / 864e5;
                case 'hour'   : return days * 24    + milliseconds / 36e5;
                case 'minute' : return days * 1440  + milliseconds / 6e4;
                case 'second' : return days * 86400 + milliseconds / 1000;
                // Math.floor prevents floating point math errors here
                case 'millisecond': return Math.floor(days * 864e5) + milliseconds;
                default: throw new Error('Unknown unit ' + units);
            }
        }
    }

    // TODO: Use this.as('ms')?
    function valueOf$1 () {
        if (!this.isValid()) {
            return NaN;
        }
        return (
            this._milliseconds +
            this._days * 864e5 +
            (this._months % 12) * 2592e6 +
            toInt(this._months / 12) * 31536e6
        );
    }

    function makeAs (alias) {
        return function () {
            return this.as(alias);
        };
    }

    var asMilliseconds = makeAs('ms');
    var asSeconds      = makeAs('s');
    var asMinutes      = makeAs('m');
    var asHours        = makeAs('h');
    var asDays         = makeAs('d');
    var asWeeks        = makeAs('w');
    var asMonths       = makeAs('M');
    var asQuarters     = makeAs('Q');
    var asYears        = makeAs('y');

    function clone$1 () {
        return createDuration(this);
    }

    function get$2 (units) {
        units = normalizeUnits(units);
        return this.isValid() ? this[units + 's']() : NaN;
    }

    function makeGetter(name) {
        return function () {
            return this.isValid() ? this._data[name] : NaN;
        };
    }

    var milliseconds = makeGetter('milliseconds');
    var seconds      = makeGetter('seconds');
    var minutes      = makeGetter('minutes');
    var hours        = makeGetter('hours');
    var days         = makeGetter('days');
    var months       = makeGetter('months');
    var years        = makeGetter('years');

    function weeks () {
        return absFloor(this.days() / 7);
    }

    var round = Math.round;
    var thresholds = {
        ss: 44,         // a few seconds to seconds
        s : 45,         // seconds to minute
        m : 45,         // minutes to hour
        h : 22,         // hours to day
        d : 26,         // days to month
        M : 11          // months to year
    };

    // helper function for moment.fn.from, moment.fn.fromNow, and moment.duration.fn.humanize
    function substituteTimeAgo(string, number, withoutSuffix, isFuture, locale) {
        return locale.relativeTime(number || 1, !!withoutSuffix, string, isFuture);
    }

    function relativeTime$1 (posNegDuration, withoutSuffix, locale) {
        var duration = createDuration(posNegDuration).abs();
        var seconds  = round(duration.as('s'));
        var minutes  = round(duration.as('m'));
        var hours    = round(duration.as('h'));
        var days     = round(duration.as('d'));
        var months   = round(duration.as('M'));
        var years    = round(duration.as('y'));

        var a = seconds <= thresholds.ss && ['s', seconds]  ||
                seconds < thresholds.s   && ['ss', seconds] ||
                minutes <= 1             && ['m']           ||
                minutes < thresholds.m   && ['mm', minutes] ||
                hours   <= 1             && ['h']           ||
                hours   < thresholds.h   && ['hh', hours]   ||
                days    <= 1             && ['d']           ||
                days    < thresholds.d   && ['dd', days]    ||
                months  <= 1             && ['M']           ||
                months  < thresholds.M   && ['MM', months]  ||
                years   <= 1             && ['y']           || ['yy', years];

        a[2] = withoutSuffix;
        a[3] = +posNegDuration > 0;
        a[4] = locale;
        return substituteTimeAgo.apply(null, a);
    }

    // This function allows you to set the rounding function for relative time strings
    function getSetRelativeTimeRounding (roundingFunction) {
        if (roundingFunction === undefined) {
            return round;
        }
        if (typeof(roundingFunction) === 'function') {
            round = roundingFunction;
            return true;
        }
        return false;
    }

    // This function allows you to set a threshold for relative time strings
    function getSetRelativeTimeThreshold (threshold, limit) {
        if (thresholds[threshold] === undefined) {
            return false;
        }
        if (limit === undefined) {
            return thresholds[threshold];
        }
        thresholds[threshold] = limit;
        if (threshold === 's') {
            thresholds.ss = limit - 1;
        }
        return true;
    }

    function humanize (withSuffix) {
        if (!this.isValid()) {
            return this.localeData().invalidDate();
        }

        var locale = this.localeData();
        var output = relativeTime$1(this, !withSuffix, locale);

        if (withSuffix) {
            output = locale.pastFuture(+this, output);
        }

        return locale.postformat(output);
    }

    var abs$1 = Math.abs;

    function sign(x) {
        return ((x > 0) - (x < 0)) || +x;
    }

    function toISOString$1() {
        // for ISO strings we do not use the normal bubbling rules:
        //  * milliseconds bubble up until they become hours
        //  * days do not bubble at all
        //  * months bubble up until they become years
        // This is because there is no context-free conversion between hours and days
        // (think of clock changes)
        // and also not between days and months (28-31 days per month)
        if (!this.isValid()) {
            return this.localeData().invalidDate();
        }

        var seconds = abs$1(this._milliseconds) / 1000;
        var days         = abs$1(this._days);
        var months       = abs$1(this._months);
        var minutes, hours, years;

        // 3600 seconds -> 60 minutes -> 1 hour
        minutes           = absFloor(seconds / 60);
        hours             = absFloor(minutes / 60);
        seconds %= 60;
        minutes %= 60;

        // 12 months -> 1 year
        years  = absFloor(months / 12);
        months %= 12;


        // inspired by https://github.com/dordille/moment-isoduration/blob/master/moment.isoduration.js
        var Y = years;
        var M = months;
        var D = days;
        var h = hours;
        var m = minutes;
        var s = seconds ? seconds.toFixed(3).replace(/\.?0+$/, '') : '';
        var total = this.asSeconds();

        if (!total) {
            // this is the same as C#'s (Noda) and python (isodate)...
            // but not other JS (goog.date)
            return 'P0D';
        }

        var totalSign = total < 0 ? '-' : '';
        var ymSign = sign(this._months) !== sign(total) ? '-' : '';
        var daysSign = sign(this._days) !== sign(total) ? '-' : '';
        var hmsSign = sign(this._milliseconds) !== sign(total) ? '-' : '';

        return totalSign + 'P' +
            (Y ? ymSign + Y + 'Y' : '') +
            (M ? ymSign + M + 'M' : '') +
            (D ? daysSign + D + 'D' : '') +
            ((h || m || s) ? 'T' : '') +
            (h ? hmsSign + h + 'H' : '') +
            (m ? hmsSign + m + 'M' : '') +
            (s ? hmsSign + s + 'S' : '');
    }

    var proto$2 = Duration.prototype;

    proto$2.isValid        = isValid$1;
    proto$2.abs            = abs;
    proto$2.add            = add$1;
    proto$2.subtract       = subtract$1;
    proto$2.as             = as;
    proto$2.asMilliseconds = asMilliseconds;
    proto$2.asSeconds      = asSeconds;
    proto$2.asMinutes      = asMinutes;
    proto$2.asHours        = asHours;
    proto$2.asDays         = asDays;
    proto$2.asWeeks        = asWeeks;
    proto$2.asMonths       = asMonths;
    proto$2.asQuarters     = asQuarters;
    proto$2.asYears        = asYears;
    proto$2.valueOf        = valueOf$1;
    proto$2._bubble        = bubble;
    proto$2.clone          = clone$1;
    proto$2.get            = get$2;
    proto$2.milliseconds   = milliseconds;
    proto$2.seconds        = seconds;
    proto$2.minutes        = minutes;
    proto$2.hours          = hours;
    proto$2.days           = days;
    proto$2.weeks          = weeks;
    proto$2.months         = months;
    proto$2.years          = years;
    proto$2.humanize       = humanize;
    proto$2.toISOString    = toISOString$1;
    proto$2.toString       = toISOString$1;
    proto$2.toJSON         = toISOString$1;
    proto$2.locale         = locale;
    proto$2.localeData     = localeData;

    proto$2.toIsoString = deprecate('toIsoString() is deprecated. Please use toISOString() instead (notice the capitals)', toISOString$1);
    proto$2.lang = lang;

    // Side effect imports

    // FORMATTING

    addFormatToken('X', 0, 0, 'unix');
    addFormatToken('x', 0, 0, 'valueOf');

    // PARSING

    addRegexToken('x', matchSigned);
    addRegexToken('X', matchTimestamp);
    addParseToken('X', function (input, array, config) {
        config._d = new Date(parseFloat(input, 10) * 1000);
    });
    addParseToken('x', function (input, array, config) {
        config._d = new Date(toInt(input));
    });

    // Side effect imports


    hooks.version = '2.24.0';

    setHookCallback(createLocal);

    hooks.fn                    = proto;
    hooks.min                   = min;
    hooks.max                   = max;
    hooks.now                   = now;
    hooks.utc                   = createUTC;
    hooks.unix                  = createUnix;
    hooks.months                = listMonths;
    hooks.isDate                = isDate;
    hooks.locale                = getSetGlobalLocale;
    hooks.invalid               = createInvalid;
    hooks.duration              = createDuration;
    hooks.isMoment              = isMoment;
    hooks.weekdays              = listWeekdays;
    hooks.parseZone             = createInZone;
    hooks.localeData            = getLocale;
    hooks.isDuration            = isDuration;
    hooks.monthsShort           = listMonthsShort;
    hooks.weekdaysMin           = listWeekdaysMin;
    hooks.defineLocale          = defineLocale;
    hooks.updateLocale          = updateLocale;
    hooks.locales               = listLocales;
    hooks.weekdaysShort         = listWeekdaysShort;
    hooks.normalizeUnits        = normalizeUnits;
    hooks.relativeTimeRounding  = getSetRelativeTimeRounding;
    hooks.relativeTimeThreshold = getSetRelativeTimeThreshold;
    hooks.calendarFormat        = getCalendarFormat;
    hooks.prototype             = proto;

    // currently HTML5 input type only supports 24-hour formats
    hooks.HTML5_FMT = {
        DATETIME_LOCAL: 'YYYY-MM-DDTHH:mm',             // <input type="datetime-local" />
        DATETIME_LOCAL_SECONDS: 'YYYY-MM-DDTHH:mm:ss',  // <input type="datetime-local" step="1" />
        DATETIME_LOCAL_MS: 'YYYY-MM-DDTHH:mm:ss.SSS',   // <input type="datetime-local" step="0.001" />
        DATE: 'YYYY-MM-DD',                             // <input type="date" />
        TIME: 'HH:mm',                                  // <input type="time" />
        TIME_SECONDS: 'HH:mm:ss',                       // <input type="time" step="1" />
        TIME_MS: 'HH:mm:ss.SSS',                        // <input type="time" step="0.001" />
        WEEK: 'GGGG-[W]WW',                             // <input type="week" />
        MONTH: 'YYYY-MM'                                // <input type="month" />
    };

    return hooks;

})));

},{}],14:[function(require,module,exports){
// shim for using process in browser
var process = module.exports = {};

// cached from whatever global is present so that test runners that stub it
// don't break things.  But we need to wrap it in a try catch in case it is
// wrapped in strict mode code which doesn't define any globals.  It's inside a
// function because try/catches deoptimize in certain engines.

var cachedSetTimeout;
var cachedClearTimeout;

function defaultSetTimout() {
    throw new Error('setTimeout has not been defined');
}
function defaultClearTimeout () {
    throw new Error('clearTimeout has not been defined');
}
(function () {
    try {
        if (typeof setTimeout === 'function') {
            cachedSetTimeout = setTimeout;
        } else {
            cachedSetTimeout = defaultSetTimout;
        }
    } catch (e) {
        cachedSetTimeout = defaultSetTimout;
    }
    try {
        if (typeof clearTimeout === 'function') {
            cachedClearTimeout = clearTimeout;
        } else {
            cachedClearTimeout = defaultClearTimeout;
        }
    } catch (e) {
        cachedClearTimeout = defaultClearTimeout;
    }
} ())
function runTimeout(fun) {
    if (cachedSetTimeout === setTimeout) {
        //normal enviroments in sane situations
        return setTimeout(fun, 0);
    }
    // if setTimeout wasn't available but was latter defined
    if ((cachedSetTimeout === defaultSetTimout || !cachedSetTimeout) && setTimeout) {
        cachedSetTimeout = setTimeout;
        return setTimeout(fun, 0);
    }
    try {
        // when when somebody has screwed with setTimeout but no I.E. maddness
        return cachedSetTimeout(fun, 0);
    } catch(e){
        try {
            // When we are in I.E. but the script has been evaled so I.E. doesn't trust the global object when called normally
            return cachedSetTimeout.call(null, fun, 0);
        } catch(e){
            // same as above but when it's a version of I.E. that must have the global object for 'this', hopfully our context correct otherwise it will throw a global error
            return cachedSetTimeout.call(this, fun, 0);
        }
    }


}
function runClearTimeout(marker) {
    if (cachedClearTimeout === clearTimeout) {
        //normal enviroments in sane situations
        return clearTimeout(marker);
    }
    // if clearTimeout wasn't available but was latter defined
    if ((cachedClearTimeout === defaultClearTimeout || !cachedClearTimeout) && clearTimeout) {
        cachedClearTimeout = clearTimeout;
        return clearTimeout(marker);
    }
    try {
        // when when somebody has screwed with setTimeout but no I.E. maddness
        return cachedClearTimeout(marker);
    } catch (e){
        try {
            // When we are in I.E. but the script has been evaled so I.E. doesn't  trust the global object when called normally
            return cachedClearTimeout.call(null, marker);
        } catch (e){
            // same as above but when it's a version of I.E. that must have the global object for 'this', hopfully our context correct otherwise it will throw a global error.
            // Some versions of I.E. have different rules for clearTimeout vs setTimeout
            return cachedClearTimeout.call(this, marker);
        }
    }



}
var queue = [];
var draining = false;
var currentQueue;
var queueIndex = -1;

function cleanUpNextTick() {
    if (!draining || !currentQueue) {
        return;
    }
    draining = false;
    if (currentQueue.length) {
        queue = currentQueue.concat(queue);
    } else {
        queueIndex = -1;
    }
    if (queue.length) {
        drainQueue();
    }
}

function drainQueue() {
    if (draining) {
        return;
    }
    var timeout = runTimeout(cleanUpNextTick);
    draining = true;

    var len = queue.length;
    while(len) {
        currentQueue = queue;
        queue = [];
        while (++queueIndex < len) {
            if (currentQueue) {
                currentQueue[queueIndex].run();
            }
        }
        queueIndex = -1;
        len = queue.length;
    }
    currentQueue = null;
    draining = false;
    runClearTimeout(timeout);
}

process.nextTick = function (fun) {
    var args = new Array(arguments.length - 1);
    if (arguments.length > 1) {
        for (var i = 1; i < arguments.length; i++) {
            args[i - 1] = arguments[i];
        }
    }
    queue.push(new Item(fun, args));
    if (queue.length === 1 && !draining) {
        runTimeout(drainQueue);
    }
};

// v8 likes predictible objects
function Item(fun, array) {
    this.fun = fun;
    this.array = array;
}
Item.prototype.run = function () {
    this.fun.apply(null, this.array);
};
process.title = 'browser';
process.browser = true;
process.env = {};
process.argv = [];
process.version = ''; // empty string to avoid regexp issues
process.versions = {};

function noop() {}

process.on = noop;
process.addListener = noop;
process.once = noop;
process.off = noop;
process.removeListener = noop;
process.removeAllListeners = noop;
process.emit = noop;
process.prependListener = noop;
process.prependOnceListener = noop;

process.listeners = function (name) { return [] }

process.binding = function (name) {
    throw new Error('process.binding is not supported');
};

process.cwd = function () { return '/' };
process.chdir = function (dir) {
    throw new Error('process.chdir is not supported');
};
process.umask = function() { return 0; };

},{}],15:[function(require,module,exports){
(function (global){
/*! https://mths.be/punycode v1.4.1 by @mathias */
;(function(root) {

	/** Detect free variables */
	var freeExports = typeof exports == 'object' && exports &&
		!exports.nodeType && exports;
	var freeModule = typeof module == 'object' && module &&
		!module.nodeType && module;
	var freeGlobal = typeof global == 'object' && global;
	if (
		freeGlobal.global === freeGlobal ||
		freeGlobal.window === freeGlobal ||
		freeGlobal.self === freeGlobal
	) {
		root = freeGlobal;
	}

	/**
	 * The `punycode` object.
	 * @name punycode
	 * @type Object
	 */
	var punycode,

	/** Highest positive signed 32-bit float value */
	maxInt = 2147483647, // aka. 0x7FFFFFFF or 2^31-1

	/** Bootstring parameters */
	base = 36,
	tMin = 1,
	tMax = 26,
	skew = 38,
	damp = 700,
	initialBias = 72,
	initialN = 128, // 0x80
	delimiter = '-', // '\x2D'

	/** Regular expressions */
	regexPunycode = /^xn--/,
	regexNonASCII = /[^\x20-\x7E]/, // unprintable ASCII chars + non-ASCII chars
	regexSeparators = /[\x2E\u3002\uFF0E\uFF61]/g, // RFC 3490 separators

	/** Error messages */
	errors = {
		'overflow': 'Overflow: input needs wider integers to process',
		'not-basic': 'Illegal input >= 0x80 (not a basic code point)',
		'invalid-input': 'Invalid input'
	},

	/** Convenience shortcuts */
	baseMinusTMin = base - tMin,
	floor = Math.floor,
	stringFromCharCode = String.fromCharCode,

	/** Temporary variable */
	key;

	/*--------------------------------------------------------------------------*/

	/**
	 * A generic error utility function.
	 * @private
	 * @param {String} type The error type.
	 * @returns {Error} Throws a `RangeError` with the applicable error message.
	 */
	function error(type) {
		throw new RangeError(errors[type]);
	}

	/**
	 * A generic `Array#map` utility function.
	 * @private
	 * @param {Array} array The array to iterate over.
	 * @param {Function} callback The function that gets called for every array
	 * item.
	 * @returns {Array} A new array of values returned by the callback function.
	 */
	function map(array, fn) {
		var length = array.length;
		var result = [];
		while (length--) {
			result[length] = fn(array[length]);
		}
		return result;
	}

	/**
	 * A simple `Array#map`-like wrapper to work with domain name strings or email
	 * addresses.
	 * @private
	 * @param {String} domain The domain name or email address.
	 * @param {Function} callback The function that gets called for every
	 * character.
	 * @returns {Array} A new string of characters returned by the callback
	 * function.
	 */
	function mapDomain(string, fn) {
		var parts = string.split('@');
		var result = '';
		if (parts.length > 1) {
			// In email addresses, only the domain name should be punycoded. Leave
			// the local part (i.e. everything up to `@`) intact.
			result = parts[0] + '@';
			string = parts[1];
		}
		// Avoid `split(regex)` for IE8 compatibility. See #17.
		string = string.replace(regexSeparators, '\x2E');
		var labels = string.split('.');
		var encoded = map(labels, fn).join('.');
		return result + encoded;
	}

	/**
	 * Creates an array containing the numeric code points of each Unicode
	 * character in the string. While JavaScript uses UCS-2 internally,
	 * this function will convert a pair of surrogate halves (each of which
	 * UCS-2 exposes as separate characters) into a single code point,
	 * matching UTF-16.
	 * @see `punycode.ucs2.encode`
	 * @see <https://mathiasbynens.be/notes/javascript-encoding>
	 * @memberOf punycode.ucs2
	 * @name decode
	 * @param {String} string The Unicode input string (UCS-2).
	 * @returns {Array} The new array of code points.
	 */
	function ucs2decode(string) {
		var output = [],
		    counter = 0,
		    length = string.length,
		    value,
		    extra;
		while (counter < length) {
			value = string.charCodeAt(counter++);
			if (value >= 0xD800 && value <= 0xDBFF && counter < length) {
				// high surrogate, and there is a next character
				extra = string.charCodeAt(counter++);
				if ((extra & 0xFC00) == 0xDC00) { // low surrogate
					output.push(((value & 0x3FF) << 10) + (extra & 0x3FF) + 0x10000);
				} else {
					// unmatched surrogate; only append this code unit, in case the next
					// code unit is the high surrogate of a surrogate pair
					output.push(value);
					counter--;
				}
			} else {
				output.push(value);
			}
		}
		return output;
	}

	/**
	 * Creates a string based on an array of numeric code points.
	 * @see `punycode.ucs2.decode`
	 * @memberOf punycode.ucs2
	 * @name encode
	 * @param {Array} codePoints The array of numeric code points.
	 * @returns {String} The new Unicode string (UCS-2).
	 */
	function ucs2encode(array) {
		return map(array, function(value) {
			var output = '';
			if (value > 0xFFFF) {
				value -= 0x10000;
				output += stringFromCharCode(value >>> 10 & 0x3FF | 0xD800);
				value = 0xDC00 | value & 0x3FF;
			}
			output += stringFromCharCode(value);
			return output;
		}).join('');
	}

	/**
	 * Converts a basic code point into a digit/integer.
	 * @see `digitToBasic()`
	 * @private
	 * @param {Number} codePoint The basic numeric code point value.
	 * @returns {Number} The numeric value of a basic code point (for use in
	 * representing integers) in the range `0` to `base - 1`, or `base` if
	 * the code point does not represent a value.
	 */
	function basicToDigit(codePoint) {
		if (codePoint - 48 < 10) {
			return codePoint - 22;
		}
		if (codePoint - 65 < 26) {
			return codePoint - 65;
		}
		if (codePoint - 97 < 26) {
			return codePoint - 97;
		}
		return base;
	}

	/**
	 * Converts a digit/integer into a basic code point.
	 * @see `basicToDigit()`
	 * @private
	 * @param {Number} digit The numeric value of a basic code point.
	 * @returns {Number} The basic code point whose value (when used for
	 * representing integers) is `digit`, which needs to be in the range
	 * `0` to `base - 1`. If `flag` is non-zero, the uppercase form is
	 * used; else, the lowercase form is used. The behavior is undefined
	 * if `flag` is non-zero and `digit` has no uppercase form.
	 */
	function digitToBasic(digit, flag) {
		//  0..25 map to ASCII a..z or A..Z
		// 26..35 map to ASCII 0..9
		return digit + 22 + 75 * (digit < 26) - ((flag != 0) << 5);
	}

	/**
	 * Bias adaptation function as per section 3.4 of RFC 3492.
	 * https://tools.ietf.org/html/rfc3492#section-3.4
	 * @private
	 */
	function adapt(delta, numPoints, firstTime) {
		var k = 0;
		delta = firstTime ? floor(delta / damp) : delta >> 1;
		delta += floor(delta / numPoints);
		for (/* no initialization */; delta > baseMinusTMin * tMax >> 1; k += base) {
			delta = floor(delta / baseMinusTMin);
		}
		return floor(k + (baseMinusTMin + 1) * delta / (delta + skew));
	}

	/**
	 * Converts a Punycode string of ASCII-only symbols to a string of Unicode
	 * symbols.
	 * @memberOf punycode
	 * @param {String} input The Punycode string of ASCII-only symbols.
	 * @returns {String} The resulting string of Unicode symbols.
	 */
	function decode(input) {
		// Don't use UCS-2
		var output = [],
		    inputLength = input.length,
		    out,
		    i = 0,
		    n = initialN,
		    bias = initialBias,
		    basic,
		    j,
		    index,
		    oldi,
		    w,
		    k,
		    digit,
		    t,
		    /** Cached calculation results */
		    baseMinusT;

		// Handle the basic code points: let `basic` be the number of input code
		// points before the last delimiter, or `0` if there is none, then copy
		// the first basic code points to the output.

		basic = input.lastIndexOf(delimiter);
		if (basic < 0) {
			basic = 0;
		}

		for (j = 0; j < basic; ++j) {
			// if it's not a basic code point
			if (input.charCodeAt(j) >= 0x80) {
				error('not-basic');
			}
			output.push(input.charCodeAt(j));
		}

		// Main decoding loop: start just after the last delimiter if any basic code
		// points were copied; start at the beginning otherwise.

		for (index = basic > 0 ? basic + 1 : 0; index < inputLength; /* no final expression */) {

			// `index` is the index of the next character to be consumed.
			// Decode a generalized variable-length integer into `delta`,
			// which gets added to `i`. The overflow checking is easier
			// if we increase `i` as we go, then subtract off its starting
			// value at the end to obtain `delta`.
			for (oldi = i, w = 1, k = base; /* no condition */; k += base) {

				if (index >= inputLength) {
					error('invalid-input');
				}

				digit = basicToDigit(input.charCodeAt(index++));

				if (digit >= base || digit > floor((maxInt - i) / w)) {
					error('overflow');
				}

				i += digit * w;
				t = k <= bias ? tMin : (k >= bias + tMax ? tMax : k - bias);

				if (digit < t) {
					break;
				}

				baseMinusT = base - t;
				if (w > floor(maxInt / baseMinusT)) {
					error('overflow');
				}

				w *= baseMinusT;

			}

			out = output.length + 1;
			bias = adapt(i - oldi, out, oldi == 0);

			// `i` was supposed to wrap around from `out` to `0`,
			// incrementing `n` each time, so we'll fix that now:
			if (floor(i / out) > maxInt - n) {
				error('overflow');
			}

			n += floor(i / out);
			i %= out;

			// Insert `n` at position `i` of the output
			output.splice(i++, 0, n);

		}

		return ucs2encode(output);
	}

	/**
	 * Converts a string of Unicode symbols (e.g. a domain name label) to a
	 * Punycode string of ASCII-only symbols.
	 * @memberOf punycode
	 * @param {String} input The string of Unicode symbols.
	 * @returns {String} The resulting Punycode string of ASCII-only symbols.
	 */
	function encode(input) {
		var n,
		    delta,
		    handledCPCount,
		    basicLength,
		    bias,
		    j,
		    m,
		    q,
		    k,
		    t,
		    currentValue,
		    output = [],
		    /** `inputLength` will hold the number of code points in `input`. */
		    inputLength,
		    /** Cached calculation results */
		    handledCPCountPlusOne,
		    baseMinusT,
		    qMinusT;

		// Convert the input in UCS-2 to Unicode
		input = ucs2decode(input);

		// Cache the length
		inputLength = input.length;

		// Initialize the state
		n = initialN;
		delta = 0;
		bias = initialBias;

		// Handle the basic code points
		for (j = 0; j < inputLength; ++j) {
			currentValue = input[j];
			if (currentValue < 0x80) {
				output.push(stringFromCharCode(currentValue));
			}
		}

		handledCPCount = basicLength = output.length;

		// `handledCPCount` is the number of code points that have been handled;
		// `basicLength` is the number of basic code points.

		// Finish the basic string - if it is not empty - with a delimiter
		if (basicLength) {
			output.push(delimiter);
		}

		// Main encoding loop:
		while (handledCPCount < inputLength) {

			// All non-basic code points < n have been handled already. Find the next
			// larger one:
			for (m = maxInt, j = 0; j < inputLength; ++j) {
				currentValue = input[j];
				if (currentValue >= n && currentValue < m) {
					m = currentValue;
				}
			}

			// Increase `delta` enough to advance the decoder's <n,i> state to <m,0>,
			// but guard against overflow
			handledCPCountPlusOne = handledCPCount + 1;
			if (m - n > floor((maxInt - delta) / handledCPCountPlusOne)) {
				error('overflow');
			}

			delta += (m - n) * handledCPCountPlusOne;
			n = m;

			for (j = 0; j < inputLength; ++j) {
				currentValue = input[j];

				if (currentValue < n && ++delta > maxInt) {
					error('overflow');
				}

				if (currentValue == n) {
					// Represent delta as a generalized variable-length integer
					for (q = delta, k = base; /* no condition */; k += base) {
						t = k <= bias ? tMin : (k >= bias + tMax ? tMax : k - bias);
						if (q < t) {
							break;
						}
						qMinusT = q - t;
						baseMinusT = base - t;
						output.push(
							stringFromCharCode(digitToBasic(t + qMinusT % baseMinusT, 0))
						);
						q = floor(qMinusT / baseMinusT);
					}

					output.push(stringFromCharCode(digitToBasic(q, 0)));
					bias = adapt(delta, handledCPCountPlusOne, handledCPCount == basicLength);
					delta = 0;
					++handledCPCount;
				}
			}

			++delta;
			++n;

		}
		return output.join('');
	}

	/**
	 * Converts a Punycode string representing a domain name or an email address
	 * to Unicode. Only the Punycoded parts of the input will be converted, i.e.
	 * it doesn't matter if you call it on a string that has already been
	 * converted to Unicode.
	 * @memberOf punycode
	 * @param {String} input The Punycoded domain name or email address to
	 * convert to Unicode.
	 * @returns {String} The Unicode representation of the given Punycode
	 * string.
	 */
	function toUnicode(input) {
		return mapDomain(input, function(string) {
			return regexPunycode.test(string)
				? decode(string.slice(4).toLowerCase())
				: string;
		});
	}

	/**
	 * Converts a Unicode string representing a domain name or an email address to
	 * Punycode. Only the non-ASCII parts of the domain name will be converted,
	 * i.e. it doesn't matter if you call it with a domain that's already in
	 * ASCII.
	 * @memberOf punycode
	 * @param {String} input The domain name or email address to convert, as a
	 * Unicode string.
	 * @returns {String} The Punycode representation of the given domain name or
	 * email address.
	 */
	function toASCII(input) {
		return mapDomain(input, function(string) {
			return regexNonASCII.test(string)
				? 'xn--' + encode(string)
				: string;
		});
	}

	/*--------------------------------------------------------------------------*/

	/** Define the public API */
	punycode = {
		/**
		 * A string representing the current Punycode.js version number.
		 * @memberOf punycode
		 * @type String
		 */
		'version': '1.4.1',
		/**
		 * An object of methods to convert from JavaScript's internal character
		 * representation (UCS-2) to Unicode code points, and back.
		 * @see <https://mathiasbynens.be/notes/javascript-encoding>
		 * @memberOf punycode
		 * @type Object
		 */
		'ucs2': {
			'decode': ucs2decode,
			'encode': ucs2encode
		},
		'decode': decode,
		'encode': encode,
		'toASCII': toASCII,
		'toUnicode': toUnicode
	};

	/** Expose `punycode` */
	// Some AMD build optimizers, like r.js, check for specific condition patterns
	// like the following:
	if (
		typeof define == 'function' &&
		typeof define.amd == 'object' &&
		define.amd
	) {
		define('punycode', function() {
			return punycode;
		});
	} else if (freeExports && freeModule) {
		if (module.exports == freeExports) {
			// in Node.js, io.js, or RingoJS v0.8.0+
			freeModule.exports = punycode;
		} else {
			// in Narwhal or RingoJS v0.7.0-
			for (key in punycode) {
				punycode.hasOwnProperty(key) && (freeExports[key] = punycode[key]);
			}
		}
	} else {
		// in Rhino or a web browser
		root.punycode = punycode;
	}

}(this));

}).call(this,typeof global !== "undefined" ? global : typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : {})
},{}],16:[function(require,module,exports){
(function (Buffer){
(function() {
  var crypt = require('crypt'),
      utf8 = require('charenc').utf8,
      bin = require('charenc').bin,

  // The core
  sha1 = function (message) {
    // Convert to byte array
    if (message.constructor == String)
      message = utf8.stringToBytes(message);
    else if (typeof Buffer !== 'undefined' && typeof Buffer.isBuffer == 'function' && Buffer.isBuffer(message))
      message = Array.prototype.slice.call(message, 0);
    else if (!Array.isArray(message))
      message = message.toString();

    // otherwise assume byte array

    var m  = crypt.bytesToWords(message),
        l  = message.length * 8,
        w  = [],
        H0 =  1732584193,
        H1 = -271733879,
        H2 = -1732584194,
        H3 =  271733878,
        H4 = -1009589776;

    // Padding
    m[l >> 5] |= 0x80 << (24 - l % 32);
    m[((l + 64 >>> 9) << 4) + 15] = l;

    for (var i = 0; i < m.length; i += 16) {
      var a = H0,
          b = H1,
          c = H2,
          d = H3,
          e = H4;

      for (var j = 0; j < 80; j++) {

        if (j < 16)
          w[j] = m[i + j];
        else {
          var n = w[j - 3] ^ w[j - 8] ^ w[j - 14] ^ w[j - 16];
          w[j] = (n << 1) | (n >>> 31);
        }

        var t = ((H0 << 5) | (H0 >>> 27)) + H4 + (w[j] >>> 0) + (
                j < 20 ? (H1 & H2 | ~H1 & H3) + 1518500249 :
                j < 40 ? (H1 ^ H2 ^ H3) + 1859775393 :
                j < 60 ? (H1 & H2 | H1 & H3 | H2 & H3) - 1894007588 :
                         (H1 ^ H2 ^ H3) - 899497514);

        H4 = H3;
        H3 = H2;
        H2 = (H1 << 30) | (H1 >>> 2);
        H1 = H0;
        H0 = t;
      }

      H0 += a;
      H1 += b;
      H2 += c;
      H3 += d;
      H4 += e;
    }

    return [H0, H1, H2, H3, H4];
  },

  // Public API
  api = function (message, options) {
    var digestbytes = crypt.wordsToBytes(sha1(message));
    return options && options.asBytes ? digestbytes :
        options && options.asString ? bin.bytesToString(digestbytes) :
        crypt.bytesToHex(digestbytes);
  };

  api._blocksize = 16;
  api._digestsize = 20;

  module.exports = api;
})();

}).call(this,require("buffer").Buffer)
},{"buffer":5,"charenc":6,"crypt":8}],17:[function(require,module,exports){
(function (setImmediate,clearImmediate){
var nextTick = require('process/browser.js').nextTick;
var apply = Function.prototype.apply;
var slice = Array.prototype.slice;
var immediateIds = {};
var nextImmediateId = 0;

// DOM APIs, for completeness

exports.setTimeout = function() {
  return new Timeout(apply.call(setTimeout, window, arguments), clearTimeout);
};
exports.setInterval = function() {
  return new Timeout(apply.call(setInterval, window, arguments), clearInterval);
};
exports.clearTimeout =
exports.clearInterval = function(timeout) { timeout.close(); };

function Timeout(id, clearFn) {
  this._id = id;
  this._clearFn = clearFn;
}
Timeout.prototype.unref = Timeout.prototype.ref = function() {};
Timeout.prototype.close = function() {
  this._clearFn.call(window, this._id);
};

// Does not start the time, just sets up the members needed.
exports.enroll = function(item, msecs) {
  clearTimeout(item._idleTimeoutId);
  item._idleTimeout = msecs;
};

exports.unenroll = function(item) {
  clearTimeout(item._idleTimeoutId);
  item._idleTimeout = -1;
};

exports._unrefActive = exports.active = function(item) {
  clearTimeout(item._idleTimeoutId);

  var msecs = item._idleTimeout;
  if (msecs >= 0) {
    item._idleTimeoutId = setTimeout(function onTimeout() {
      if (item._onTimeout)
        item._onTimeout();
    }, msecs);
  }
};

// That's not how node.js implements it but the exposed api is the same.
exports.setImmediate = typeof setImmediate === "function" ? setImmediate : function(fn) {
  var id = nextImmediateId++;
  var args = arguments.length < 2 ? false : slice.call(arguments, 1);

  immediateIds[id] = true;

  nextTick(function onNextTick() {
    if (immediateIds[id]) {
      // fn.call() is faster so we optimize for the common use-case
      // @see http://jsperf.com/call-apply-segu
      if (args) {
        fn.apply(null, args);
      } else {
        fn.call(null);
      }
      // Prevent ids from leaking
      exports.clearImmediate(id);
    }
  });

  return id;
};

exports.clearImmediate = typeof clearImmediate === "function" ? clearImmediate : function(id) {
  delete immediateIds[id];
};
}).call(this,require("timers").setImmediate,require("timers").clearImmediate)
},{"process/browser.js":14,"timers":17}],18:[function(require,module,exports){
module.exports = Interface;

const m = require("mithril");
const Moment = require("moment");
const SearchInterface = require("./searchinterface");
const helpers = require("../helpers");

const LATEST_NATIVE_APP_VERSION = 3000003;

/**
 * Popup main interface
 *
 * @since 3.0.0
 *
 * @param object settings Settings object
 * @param array  logins   Array of available logins
 * @return void
 */
function Interface(settings, logins) {
    // public methods
    this.attach = attach;
    this.view = view;
    this.search = search;

    // fields
    this.settings = settings;
    this.logins = logins;
    this.results = [];
    this.currentDomainOnly = !settings.tab.url.match(/^(chrome|about):/);
    this.searchPart = new SearchInterface(this);

    // initialise with empty search
    this.search("");
}

/**
 * Attach the interface on the given element
 *
 * @since 3.0.0
 *
 * @param DOMElement element Target element
 * @return void
 */
function attach(element) {
    m.mount(element, this);
}

/**
 * Generates vnodes for render
 *
 * @since 3.0.0
 *
 * @param function ctl    Controller
 * @param object   params Runtime params
 * @return []Vnode
 */
function view(ctl, params) {
    var nodes = [];
    nodes.push(m(this.searchPart));

    nodes.push(
        m(
            "div.logins",
            this.results.map(function(result) {
                const storeBgColor = result.store.bgColor || result.store.settings.bgColor;
                const storeColor = result.store.color || result.store.settings.color;

                return m(
                    "div.part.login",
                    {
                        key: result.index,
                        tabindex: 0,
                        onclick: function(e) {
                            var action = e.target.getAttribute("action");
                            if (action) {
                                result.doAction(action);
                            } else {
                                result.doAction("fill");
                            }
                        },
                        onkeydown: keyHandler.bind(result)
                    },
                    [
                        m("div.name", [
                            m("div.line1", [
                                m(
                                    "div.store.badge",
                                    {
                                        style: `background-color: ${storeBgColor};
                                                color: ${storeColor}`
                                    },
                                    result.store.name
                                ),
                                m("div.path", [m.trust(result.path)]),
                                result.recent.when > 0
                                    ? m("div.recent", {
                                          title:
                                              "Used here " +
                                              result.recent.count +
                                              " time" +
                                              (result.recent.count > 1 ? "s" : "") +
                                              ", last " +
                                              Moment(new Date(result.recent.when)).fromNow()
                                      })
                                    : null
                            ]),
                            m("div.line2", [m.trust(result.display)])
                        ]),
                        m("div.action.copy-password", {
                            tabindex: 0,
                            title: "Copy password",
                            action: "copyPassword"
                        }),
                        m("div.action.copy-user", {
                            tabindex: 0,
                            title: "Copy username",
                            action: "copyUsername"
                        })
                    ]
                );
            })
        )
    );

    if (this.settings.version < LATEST_NATIVE_APP_VERSION) {
        nodes.push(
            m("div.updates", [
                m("span", "Update native host app: "),
                m(
                    "a",
                    {
                        href: "https://github.com/browserpass/browserpass-native#installation",
                        target: "_blank"
                    },
                    "instructions"
                )
            ])
        );
    }

    return nodes;
}

/**
 * Run a search
 *
 * @param string searchQuery Search query
 * @return void
 */
function search(searchQuery) {
    this.results = helpers.filterSortLogins(this.logins, searchQuery, this.currentDomainOnly);
}

/**
 * Handle result key presses
 *
 * @param Event  e    Keydown event
 * @param object this Result object
 * @return void
 */
function keyHandler(e) {
    e.preventDefault();
    var login = e.target.classList.contains("login") ? e.target : e.target.closest(".login");
    switch (e.code) {
        case "Tab":
            var partElement = e.target.closest(".part");
            var targetElement = e.shiftKey ? "previousElementSibling" : "nextElementSibling";
            if (partElement[targetElement] && partElement[targetElement].hasAttribute("tabindex")) {
                partElement[targetElement].focus();
            } else {
                document.querySelector(".part.search input[type=text]").focus();
            }
            break;
        case "ArrowDown":
            if (login.nextElementSibling) {
                login.nextElementSibling.focus();
            }
            break;
        case "ArrowUp":
            if (login.previousElementSibling) {
                login.previousElementSibling.focus();
            } else {
                document.querySelector(".part.search input[type=text]").focus();
            }
            break;
        case "ArrowRight":
            if (e.target.classList.contains("login")) {
                e.target.querySelector(".action").focus();
            } else if (e.target.nextElementSibling) {
                e.target.nextElementSibling.focus();
            }
            break;
        case "ArrowLeft":
            if (e.target.previousElementSibling.classList.contains("action")) {
                e.target.previousElementSibling.focus();
            } else {
                login.focus();
            }
            break;
        case "Enter":
            if (e.target.hasAttribute("action")) {
                this.doAction(e.target.getAttribute("action"));
            } else {
                this.doAction("fill");
            }
            break;
        case "KeyC":
            if (e.ctrlKey) {
                if (e.shiftKey || document.activeElement.classList.contains("copy-user")) {
                    this.doAction("copyUsername");
                } else {
                    this.doAction("copyPassword");
                }
            }
            break;
        case "KeyG":
            if (e.ctrlKey) {
                this.doAction(e.shiftKey ? "launchInNewTab" : "launch");
            }
            break;
    }
}

},{"../helpers":1,"./searchinterface":20,"mithril":12,"moment":13}],19:[function(require,module,exports){
//------------------------------------- Initialisation --------------------------------------//
"use strict";

require("chrome-extension-async");
const Interface = require("./interface");
const helpers = require("../helpers");

run();

//----------------------------------- Function definitions ----------------------------------//

/**
 * Handle an error
 *
 * @since 3.0.0
 *
 * @param Error error Error object
 * @param string type Error type
 */
function handleError(error, type = "error") {
    if (type == "error") {
        console.log(error);
    }
    var errorNode = document.createElement("div");
    errorNode.setAttribute("class", "part " + type);
    errorNode.textContent = error.toString();
    document.body.innerHTML = "";
    document.body.appendChild(errorNode);
}

/**
 * Run the main popup logic
 *
 * @since 3.0.0
 *
 * @return void
 */
async function run() {
    try {
        var response = await chrome.runtime.sendMessage({ action: "getSettings" });
        if (response.status != "ok") {
            throw new Error(response.message);
        }
        var settings = response.settings;

        var root = document.getElementsByTagName("html")[0];
        root.classList.remove("colors-dark");
        root.classList.add(`colors-${settings.theme}`);

        if (settings.hasOwnProperty("hostError")) {
            throw new Error(settings.hostError.params.message);
        }

        if (typeof settings.origin === "undefined") {
            throw new Error("Unable to retrieve current tab information");
        }

        // get list of logins
        response = await chrome.runtime.sendMessage({ action: "listFiles" });
        if (response.status != "ok") {
            throw new Error(response.message);
        }

        const logins = helpers.prepareLogins(response.files, settings);
        for (let login of logins) {
            login.doAction = withLogin.bind({ settings: settings, login: login });
        }

        var popup = new Interface(settings, logins);
        popup.attach(document.body);
    } catch (e) {
        handleError(e);
    }
}

/**
 * Do a login action
 *
 * @since 3.0.0
 *
 * @param string action Action to take
 * @return void
 */
async function withLogin(action) {
    try {
        // replace popup with a "please wait" notice
        switch (action) {
            case "fill":
                handleError("Filling login details...", "notice");
                break;
            case "launch":
                handleError("Launching URL...", "notice");
                break;
            case "launchInNewTab":
                handleError("Launching URL in a new tab...", "notice");
                break;
            case "copyPassword":
                handleError("Copying password to clipboard...", "notice");
                break;
            case "copyUsername":
                handleError("Copying username to clipboard...", "notice");
                break;
            default:
                handleError("Please wait...", "notice");
                break;
        }

        // Firefox requires data to be serializable,
        // this removes everything offending such as functions
        const login = JSON.parse(JSON.stringify(this.login));

        // hand off action to background script
        var response = await chrome.runtime.sendMessage({
            action: action,
            login: login
        });
        if (response.status != "ok") {
            throw new Error(response.message);
        } else {
            window.close();
        }
    } catch (e) {
        handleError(e);
    }
}

},{"../helpers":1,"./interface":18,"chrome-extension-async":7}],20:[function(require,module,exports){
module.exports = SearchInterface;

const m = require("mithril");

/**
 * Search interface
 *
 * @since 3.0.0
 *
 * @param object interface Popup main interface
 * @return void
 */
function SearchInterface(popup) {
    // public methods
    this.view = view;

    // fields
    this.popup = popup;
}

/**
 * Generates vnodes for render
 *
 * @since 3.0.0
 *
 * @param function ctl    Controller
 * @param object   params Runtime params
 * @return []Vnode
 */
function view(ctl, params) {
    var self = this;
    var host = new URL(this.popup.settings.origin).host;
    return m(
        "form.part.search",
        {
            onkeydown: function(e) {
                switch (e.code) {
                    case "Tab":
                        e.preventDefault();
                        if (e.shiftKey) {
                            document.querySelector(".part.login:last-child").focus();
                            break;
                        }
                    // fall through to ArrowDown
                    case "ArrowDown":
                        e.preventDefault();
                        if (self.popup.results.length) {
                            document.querySelector("*[tabindex]").focus();
                        }
                        break;
                    case "Enter":
                        e.preventDefault();
                        if (self.popup.results.length) {
                            self.popup.results[0].doAction("fill");
                        }
                        break;
                }
            }
        },
        [
            this.popup.currentDomainOnly
                ? m("div.hint.badge", [
                      host,
                      m("div.remove-hint", {
                          onclick: function(e) {
                              var target = document.querySelector(
                                  ".part.search > input[type=text]"
                              );
                              target.focus();
                              self.popup.currentDomainOnly = false;
                              self.popup.search(target.value);
                          }
                      })
                  ])
                : null,
            m("input[type=text]", {
                focused: true,
                placeholder: "Search logins...",
                oncreate: function(e) {
                    e.dom.focus();
                },
                oninput: function(e) {
                    self.popup.search(e.target.value);
                },
                onkeydown: function(e) {
                    switch (e.code) {
                        case "Backspace":
                            if (self.popup.currentDomainOnly) {
                                if (e.target.value.length == 0) {
                                    self.popup.currentDomainOnly = false;
                                    self.popup.search("");
                                } else if (
                                    e.target.selectionStart == 0 &&
                                    e.target.selectionEnd == 0
                                ) {
                                    self.popup.currentDomainOnly = false;
                                    self.popup.search(e.target.value);
                                }
                            }
                            break;
                        case "KeyC":
                            if (e.ctrlKey && e.target.selectionStart == e.target.selectionEnd) {
                                e.preventDefault();
                                self.popup.results[0].doAction(
                                    e.shiftKey ? "copyUsername" : "copyPassword"
                                );
                            }
                            break;
                        case "KeyG":
                            if (e.ctrlKey && e.target.selectionStart == e.target.selectionEnd) {
                                e.preventDefault();
                                self.popup.results[0].doAction(
                                    e.shiftKey ? "launchInNewTab" : "launch"
                                );
                            }
                            break;
                    }
                }
            })
        ]
    );
}

},{"mithril":12}]},{},[19]);

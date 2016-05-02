const {classes: Cc, interfaces: Ci, utils: Cu} = Components;

Cu.import("resource://gre/modules/Services.jsm");
Cu.import("resource://gre/modules/FxAccounts.jsm");
Cu.import("resource://services-sync/main.js");
Cu.import("resource://gre/modules/Task.jsm");

const weaveService = Cc["@mozilla.org/weave/service;1"]
                     .getService(Ci.nsISupports)
                     .wrappedJSObject;

// Returns a promise that resolves when Sync is ready and logged in.
function whenSyncReady() {
  return weaveService.whenLoaded().then(() => {
    // If we don't have a user we are screwed.
    return fxAccounts.getSignedInUser();
  }).then(userData =>  {
    if (!userData) {
      return false;
    }
    if (Weave.Service.isLoggedIn) {
      return true;
    }
    return new Promise(resolve => {
      const TOPIC = "weave:service:login:finish";
      function observe(subject, topic, data) {
        Services.obs.removeObserver(observe, TOPIC);
        resolve(true);
      }
      Services.obs.addObserver(observe, TOPIC, false);
      Weave.Service.login();
    });
  });
}

function createObjectInspector(name, data, expandLevel = 1) {
  return React.createElement(ReactInspector.ObjectInspector, {name, data, expandLevel: expandLevel });
}

function createTableInspector(data) {
  return React.createElement(AboutSyncTableInspector, { data });
}

// A tab-smart "anchor"
class InternalAnchor extends React.Component {
  onClick(event) {
    // Get the chrome (ie, browser) window hosting this content.
    let chromeWindow = window
         .QueryInterface(Ci.nsIInterfaceRequestor)
         .getInterface(Ci.nsIWebNavigation)
         .QueryInterface(Ci.nsIDocShellTreeItem)
         .rootTreeItem
         .QueryInterface(Ci.nsIInterfaceRequestor)
         .getInterface(Ci.nsIDOMWindow)
         .wrappedJSObject;
    chromeWindow.switchToTabHavingURI(this.props.href, true, {
      replaceQueryString: true,
      ignoreFragment: true,
    });
    event.preventDefault();
  }

  render() {
    return React.createElement("a",
                               { href: this.props.href,
                                 onClick: event => this.onClick(event),
                               },
                               this.props.children);
  }
}

// A placeholder for when we are still fetching data.
class Fetching extends React.Component {
  render() {
    return React.createElement("p", { className: "fetching" }, this.props.label);
  }
}

class AccountInfo extends React.Component {
  constructor(props) {
    super(props);
    this.state = { user: null, profile: null }
  }

  componentDidMount() {
    fxAccounts.getSignedInUser().then(data => {
      this.setState({ user: data });
      if (data) {
        fxAccounts.getSignedInUserProfile().then(profile => {
          this.setState({ profile });
        });
      }
    }).catch(Cu.reportError);
  }

  render() {
    let user = this.state.user;
    if (!user) {
      return React.createElement(Fetching, { label: "Fetching account info..." });
    }
    let avatar = [];
    let info = [];
    let raw = [];
    if (this.state.profile) {
      let profile = this.state.profile;
      avatar.push(React.createElement('img', { src: profile.avatar, className: "avatar" }));
      info.push(React.createElement('p', null, profile.displayName));
      raw.push(createObjectInspector("Full Profile", profile, 0));
    }
    info.push(React.createElement('p', null, user.email));

    return (
      React.createElement('div', null, [
        React.createElement('div', { className: "profileContainer" }, [
          React.createElement('div', { className: "avatarContainer" }, ...avatar),
          React.createElement('div', { className: "userInfoContainer" }, ...info),
        ]),
        ...raw,
      ])
    );
  }
}

// Functions that compute additional per-collection components. Return a
// promise that resolves with an object with key=name, value=react component.
const collectionComponentBuilders = {
  bookmarks: Task.async(function* (provider, serverRecords) {
    try {
      Cu.import("resource://services-sync/bookmark_validator.js");
    } catch (_) {
      return {
        "Validation": React.createElement("p", null, "You need to update your browser to see validation results"),
      }
    }

    let clientTree = yield provider.promiseBookmarksTree();
    let validator = new BookmarkValidator();
    let validationResults = validator.compareServerWithClient(serverRecords, clientTree);
    let probs = validationResults.problemData;

    // Turn the list of records into a map keyed by ID.
    let serverMap = new Map(serverRecords.map(item => [item.id, item]));
    let clientMap = new Map(validationResults.clientRecords.map(item => [item.id, item]))

    function describeId(string, id) {
      // Return a few React components to render a string containing a guid.
      // Later I hope to make this an anchor and display more details, but
      // this will do for now.
      let descs = [];
      let childItem = clientMap.get(id);
      if (childItem) {
        descs.push(`Exists locally with title "${childItem.title}"`);
      } else {
        descs.push(`Does not exist locally`);
      }
      let serverItem = serverMap.get(id);
      if (serverItem) {
        descs.push(`Exists on the server with title "${serverItem.title}"`);
      } else {
        descs.push(`Does not exist on the server`);
      }
      let desc = descs.join("\n");
      let [left, right] = string.split("{id}");
      return [
        React.createElement("span", null, left),
        React.createElement("span", { className: "inline-id", title: desc }, id),
        React.createElement("span", null, right),
      ];
    }

    let generateResults = function* () {
      yield React.createElement("p", null, `There are ${probs.missingIDs} records without IDs`);

      for (let { parent, child } of probs.missingChildren) {
        let desc = describeId("Server record references child {id} that doesn't exist on the server.", child);
        yield React.createElement("div", null,
                React.createElement("p", null, desc),
                createTableInspector([serverMap.get(parent)])
              );
      }

      for (let { parents, child } of probs.multipleParents) {
        let data = [ serverMap.get(child) ];
        for (let parent of parents) {
          data.push(serverMap.get(parent));
        }
        let desc = describeId("Child record {id} appears as a child in multiple parents", child);
        yield React.createElement("div", null,
                React.createElement("p", null, desc),
                createTableInspector(data)
              );
      }

      for (let id of probs.childrenOnNonFolder) {
        let desc = describeId("Record {id} is not a folder but contains children.", id);
        yield React.createElement("div", null,
                React.createElement("p", null, desc),
                createTableInspector([serverMap.get(id)])
              );
      }

      for (let id of probs.serverMissing) {
        let desc = describeId("Record {id} exists locally but is not on the server", id);
        yield React.createElement("div", null,
                React.createElement("p", null, desc),
                createTableInspector([clientMap.get(id) || {oops: "no such record"}])
              );
      }

      for (let { id, differences } of probs.differences) {
        let diffTable = differences.map(field => {
          return {
            field,
            local: clientMap.get(id)[field],
            server: serverMap.get(id)[field]
          }
        });
        let desc = describeId("Record {id} has differences between local and server copies", id);
        yield React.createElement("div", null,
                React.createElement("p", null, desc),
                createTableInspector(diffTable)
              );

      }
    }

    // We can't use the tree we generated above as the bookmark validator
    // mutates it.
    let rawTree = yield PlacesUtils.promiseBookmarksTree("", {
      includeItemIds: true
    });
    return {
      "Validation": [...generateResults()],
      "Raw validation results": createObjectInspector("Validation", validationResults),
      "Client Records": createTableInspector(validationResults.clientRecords),
      "Client Tree": createObjectInspector("root", rawTree),
    };
  }),

}

// Renders a single collection
class CollectionViewer extends React.Component {
  constructor(props) {
    super(props);
    this.state = {};
  }

  componentDidMount() {
    this.props.provider.promiseCollection(this.props.info).then(result => {
      let { response, records} = result;
      // run the summary builder that's specific to this collection.
      let additionalBuilder = collectionComponentBuilders[this.props.info.name];
      this.setState({ response, records, hasAdditional: !!additionalBuilder, additional: null });
      return additionalBuilder ? additionalBuilder(this.props.provider, records) : null;
    }).then(additional => {
      this.setState({ additional });
    }).catch(err => console.error("Failed to fetch collection", err));
  }

  render() {
    let name = this.props.info.name;
    let details = [React.createElement("div", { className: "collection-header" }, name)];
    if (this.state.records === undefined) {
      details.push(React.createElement(Fetching, { label: "Fetching records..." }));
    } else {
      // Build up a set of tabs.
      let lastModified = new Date(this.props.info.lastModified);
      // "Summary" tab is first.
      let summary = React.createElement("div", null,
                      React.createElement("p", { className: "collectionSummary" }, `${this.state.records.length} records`),
                      React.createElement("span", { className: "collectionSummary" }, " last modified at "),
                      React.createElement("span", { className: "collectionSummary" }, lastModified.toString())
                    );

      let tabs = [
        React.createElement(ReactSimpleTabs.Panel, { title: "Summary"}, summary),
      ];
      // Do we have additional components for this collection?
      if (this.state.hasAdditional) {
        // We are expecting additional components - do we have them yet?
        if (this.state.additional) {
          for (let title in this.state.additional) {
            let elt = this.state.additional[title];
            tabs.push(React.createElement(ReactSimpleTabs.Panel, { title }, elt));
          }
        } else {
          tabs.push(React.createElement(Fetching, { label: "Building additional info..." }))
        }
      }
      // and tabs common to all collections.
      tabs.push(...[
        React.createElement(ReactSimpleTabs.Panel, { title: "Response" },
                            createObjectInspector("Response", this.state.response)),
        React.createElement(ReactSimpleTabs.Panel, { title: "Records (table)" },
                            createTableInspector(this.state.records)),
        React.createElement(ReactSimpleTabs.Panel, { title: "Records (object)" },
                            createObjectInspector("Records", this.state.records)),
      ]);
      details.push(React.createElement(ReactSimpleTabs, null, tabs));
    }

    return React.createElement("div", { className: "collection" },
      ...details
    );
  }
}

// Drills into info/collections, grabs sub-collections, and renders them
class CollectionsViewer extends React.Component {
  componentWillReceiveProps(nextProps) {
    this.setState( {info: null });
    this._updateCollectionInfo(nextProps.provider);
  }

  componentDidMount() {
    this._updateCollectionInfo(this.props.provider);
  }

  _updateCollectionInfo(provider) {
    provider.promiseCollectionInfo().then(info => {
      this.setState({ info, error: null });
    }).catch(err => {
      console.error("Collection viewer failed", err);
      this.setState({ error: err });
    });
  }

  render() {
    if (this.state && this.state.error) {
      return React.createElement("div", null,
               React.createElement("p", null, "Failed to load collection: " + this.state.error)
             );
    }

    if (!this.state || !this.state.info) {
      return React.createElement(Fetching, "Fetching collection info...");
    }

    let provider = this.props.provider;
    let info = this.state.info;
    let collections = [];

    for (let collection of info.collections) {
      // We skip these 2 collections as they aren't encrypted so must be
      // rendered differently, and aren't particularly interesting.
      if (collection.name == "crypto" || collection.name == "meta") {
        continue;
      }
      collections.push(
        React.createElement(CollectionViewer, { provider, info: collection })
      );
    }
    return React.createElement("div", null,
             React.createElement("p", null, "Status: " + info.status),
             ...collections
           );
  }
}

// Options for what "provider" is used.
class ProviderOptions extends React.Component {
  constructor(props) {
    super(props);
    this.state = {
      local: ProviderState.useLocalProvider,
      url: ProviderState.url,
    };
  }

  componentWillUpdate(nextProps, nextState) {
    ProviderState.useLocalProvider = nextState.local;
    ProviderState.url = nextState.url;
  }

  render() {
    let onLocalClick = event => {
      this.setState({ local: true });
    };
    let onExternalClick = event => {
      this.setState({ local: false });
    };
    let onChooseClick = () => {
      const nsIFilePicker = Ci.nsIFilePicker;
      let titleText = "Select local file";
      let fp = Cc["@mozilla.org/filepicker;1"].createInstance(nsIFilePicker);
      let fpCallback = result => {
        if (result == nsIFilePicker.returnOK) {
          this.setState({ url: fp.fileURL.spec })
        }
      }
      fp.init(window, titleText, nsIFilePicker.modeOpen);
      fp.appendFilters(nsIFilePicker.filterAll);
      fp.open(fpCallback);
    }
    let onInputChange = event => {
      this.setState({ url: event.target.value });
    }

    let local =
      React.createElement("p", null,
        React.createElement("input", { type: "radio", checked: this.state.local, onClick: onLocalClick }),
        React.createElement("span", null, "Load local Sync data")
      );
    let file =
      React.createElement("p", null,
        React.createElement("input", { type: "radio", checked: !this.state.local, onClick: onExternalClick }),
        React.createElement("span", null, "Load JSON from url"),
        React.createElement("span", { className: "provider-extra", hidden: this.state.local },
          React.createElement("input", { value: this.state.url, onChange: onInputChange }),
          React.createElement("button", {onClick: onChooseClick }, "Choose local file...")
        )
      );
    return React.createElement("div", null, local, file);
  }
}


class ProviderInfo extends React.Component {
  constructor(props) {
    super(props);
    this.state = { provider: ProviderState.newProvider() };
  }

  render() {
    let onLoadClick = () => {
      this.setState({ provider: ProviderState.newProvider() });
    }

    let onExportClick = () => {
      const nsIFilePicker = Ci.nsIFilePicker;
      let titleText = "Select name to export the JSON data to";
      let fp = Cc["@mozilla.org/filepicker;1"].createInstance(nsIFilePicker);
      let fpCallback = result => {
        if (result == nsIFilePicker.returnOK || result == nsIFilePicker.returnReplace) {
          let filename = fp.file.QueryInterface(Ci.nsILocalFile).path;
          this.state.provider.promiseExport(filename).then(() => {
            alert("File created");
          }).catch(err => {
            console.error("Failed to create file", err);
            alert("Failed to create file: " + err);
          });
        }
      }

      fp.init(window, titleText, nsIFilePicker.modeSave);
      fp.appendFilters(nsIFilePicker.filterAll);
      fp.open(fpCallback);
    }

    ReactDOM.render(React.createElement(CollectionsViewer, { provider: this.state.provider }),
                    document.getElementById('collections-info'));

    let providerIsLocal = this.state.provider.type == "local";

    return React.createElement("fieldset", null,
             React.createElement("legend", null, "Data provider options"),
             React.createElement(ProviderOptions, null),
             React.createElement("button", { onClick: onLoadClick }, "Load"),
             React.createElement("button", { onClick: onExportClick, hidden: !providerIsLocal }, "Export to file...")
           );
  }
}

// I'm sure this is very un-react-y - I'm just not sure how it should be done.
let ProviderState = {
  newProvider() {
    if (this.useLocalProvider) {
      return new Providers.LocalProvider();
    }
    return new Providers.JSONProvider(this.url);
  },

  get useLocalProvider() {
    try {
      return Services.prefs.getBoolPref("extensions.aboutsync.localProvider");
    } catch (_) {
      return true;
    }
  },

  set useLocalProvider(should) {
    Services.prefs.setBoolPref("extensions.aboutsync.localProvider", should);
  },

  get url() {
    try {
      return Services.prefs.getCharPref("extensions.aboutsync.providerURL");
    } catch (_) {
      return "";
    }
  },

  set url(url) {
    Services.prefs.setCharPref("extensions.aboutsync.providerURL", url);
  },
}


function render() {
  // I have no idea what I'm doing re element attribute states :)
  // data-logged-in is already "unknown"
  whenSyncReady().then(loggedIn => {
    for (let elt of document.querySelectorAll(".state-container")) {
      elt.setAttribute("data-logged-in", loggedIn);
    }
    if (!loggedIn) {
      // the raw html and css has us covered!
      return;
    }
    // render our react nodes
    ReactDOM.render(React.createElement(AccountInfo, null),
                    document.getElementById('account-info')
    );

    ReactDOM.render(React.createElement(LogFilesComponent, null),
                    document.getElementById('logfiles-info')
    );

    ReactDOM.render(
      React.createElement(InternalAnchor,
                          { href: "about:preferences#sync"},
                          "Open Sync Preferences"),
      document.getElementById('opensyncprefs')
    );

    ReactDOM.render(React.createElement(ProviderInfo, null),
                    document.getElementById('provider-info')
    );
  }).catch(err => console.error("render() failed", err));
}

// An observer that supports weak-refs (but kept alive by the window)
window.myobserver = {
  QueryInterface: function(iid) {
    if (!iid.equals(Ci.nsIObserver) &&
        !iid.equals(Ci.nsISupportsWeakReference) &&
        !iid.equals(Ci.nsISupports))
      throw Cr.NS_ERROR_NO_INTERFACE;

    return this;
  },
  observe: function(subject, topic, data) {
    render();
  }
};

function main() {
  render();

  const topics = [
    "fxaccounts:onlogin",
    "fxaccounts:onverified",
    "fxaccounts:onlogout",
    "fxaccounts:update",
    "fxaccounts:profilechange"
  ];
  for (let topic of topics) {
    Services.obs.addObserver(window.myobserver, topic, true);
  }
}

main();

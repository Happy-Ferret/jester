/* The standard way of declaring a model is:
   Base.model("User")
   This assumes "user" as a singular form, and "users" as a plural.
   Prefix rules: If no prefix given, default to the local domain
     If prefix given, and prefix begins with "http:", take that as the entire prefix,
        otherwise, treat it as a relative path and append it to the default prefix, adding a slash if necessary.
     Example valid prefixes, assuming current domain is "www.thoughtbot.com:8080":
       "http://www.google.com" => http://www.google.com
       "" or null => http://www.thoughtbot.com:8080
       "public/forum" => http://www.thoughtbot.com:8080/public/forum
       "/public/forum" => http://www.thoughtbot.com:8080/public/forum
*/
function Base(name, options) {
  // We delay instantiating XML.ObjTree() so that it can be listed at the end of this file instead of the beginning
  if (!Base._tree) {
    Base._tree = new XML.ObjTree();
    Base._tree.attr_prefix = "@";
  }
  if (!options) options = {};

  this._name = name;
  
  if (options.singular)
    this._singular = options.singular;
  else
    this._singular = name.toLowerCase();
  
  this._plural = this._singular.pluralize(options.plural);
  
  // Establish prefix
  default_prefix = function() {return "http://" + window.location.hostname + (window.location.port ? ":" + window.location.port : "");}
  if (options.prefix) {
    if (!options.prefix.match(/^http:/))
       this._prefix = default_prefix() + (options.prefix.match(/^\//) ? "" : "/") + options.prefix
    else
      this._prefix = options.prefix;
  }
  else
    this._prefix = default_prefix();
  
  // Initialize no attributes, no associations
  this._properties = [];
  this._associations = [];
  
  // Initialize with no errors
  this.errors = [];
}

// Model declaration helper
Base.model = function(name, options) {eval(name + " = new Base(name, options);")}

// does a request that expects XML, and parses it on return before passing it back
Base.requestXML = function(callback, url, options, user_callback) {
  parse_and_callback = function(transport) {
    return callback(Base._tree.parseXML(transport.responseText));
  }
  
  // most XML requests are going to be a GET
  if (!(options.postBody || options.parameters || options.postbody || options.method == "post"))
    options.method = "get";
    
  return Base.request(parse_and_callback, url, options, user_callback);
}

// Helper to aid in handling either async or synchronous requests
Base.request = function(callback, url, options, user_callback) {
  if (user_callback) {
    options.asynchronous = true;
    // if an options hash was given instead of a callback
    if (typeof(user_callback) == "object") {
      for (var x in user_callback)
        options[x] = user_callback[x];
      user_callback = options.onComplete;
    }
  }
  else options.asynchronous = false;
  
  if (options.asynchronous) {
    if (user_callback)
      options.onComplete = function(transport) {user_callback(callback(transport));}
    else
      options.onComplete = function(transport) {callback(transport);}
    return new Ajax.Request(url, options).transport;
  }
  else
    return callback(new Ajax.Request(url, options).transport);
}

Object.extend(Base.prototype, {
  new_record : function() {return !(this.id);},
  valid : function() {return ! this.errors.any();},
  
  find : function(id, params, callback) {
    findAllWork = function(doc) {
      // if only one result, wrap it in an array
      if (!Base.elementHasMany(doc[this._plural]))
        doc[this._plural][this._singular] = [doc[this._plural][this._singular]];
      
      var results = doc[this._plural][this._singular].map(function(elem) {
        return this.build(this._attributesFromTree(elem));
      }.bind(this));
      
      // This is better than requiring the controller to support a "limit" parameter
      if (id == "first")
        return results[0];
        
      return results; 
    }.bind(this);
    
    findOneWork = function(doc) {
      attributes = this._attributesFromTree(doc[this._singular]);
      base = this.build(attributes);
      // even if the ID didn't come back, we obviously knew the ID to search with, so set it
      if (!base._properties.include("id")) base._setAttribute("id", parseInt(id))
      return base;
    }.bind(this);
    
    if (id == "first" || id == "all") {
      var url = this._plural_url(params);
      return Base.requestXML(findAllWork, url, {}, callback);
    }
    else {
      if (isNaN(parseInt(id))) return null;
      var url = this._singular_url(id, params);
      return Base.requestXML(findOneWork, url, {}, callback);
    }
  },
  
  reload : function(callback) {
    reloadWork = function(copy) {
      this._setAttributes(copy.attributes(true));
  
      if (callback)
        return callback(this);
      else
        return this;
    }.bind(this);
    
    if (this.id) {
      if (callback)
        return this.find(this.id, {}, reloadWork);
      else
        return reloadWork(this.find(this.id));
    }
    else
      return this;
  },
  
  // This function would be named "new", if JavaScript in IE allowed that.
  build : function(attributes, options) {
    var base = new Base(this._name, {singular: this._singular, prefix: this._prefix, plural: this._plural});
    
    buildWork = function(doc) {
      base._setAttributes(base._attributesFromTree(doc[base._singular]));
    }
    
    if (options && options.checkNew)
      Base.requestXML(buildWork, base._new_url(), {asynchronous: false});
    
    // set attributes without clearing existing ones, so any attributes specified are simply overrides
    for (var attr in attributes)
      base._setAttribute(attr, attributes[attr]);
      
    return base;
  },
  
  create : function(attributes, callback) {
    var base = this.build(attributes);
    
    createWork = function(saved) {
      if (callback)
        return callback(base);
      else
        return base;
    }.bind(this);
    
    if (callback)
      return base.save(createWork);
    else
      return createWork(base.save());
  },
  
  // If not given an ID, destroys itself, if it has an ID.  If given an ID, destroys that record.
  // You can call destroy(), destroy(1), destroy(callback()), or destroy(1, callback()), and it works as you expect.
  destroy : function(given_id, callback) {
    if (typeof(given_id) == "function") {
      callback = given_id;
      given_id = null;
    }
    var id = given_id || this.id;
    if (!id) return false;
    
    destroyWork = function(transport) {
      if (transport.status == 200) {
        if (!given_id || this.id == given_id)
          this.id = null;
        return this;
      }
      else
        return false;
    }.bind(this);
    
    return Base.request(destroyWork, this._singular_url(id), {method: "delete"}, callback);
  },
  
  save : function(callback) {
    saveWork = function(transport) {
      var saved = false;

      if (transport.responseText) {
        var doc = Base._tree.parseXML(transport.responseText);

        if (doc.errors)
          this._setErrors(this._errorsFromTree(doc.errors));
          
        else if (doc[this._singular])
          this._setAttributes(this._attributesFromTree(doc[this._singular]));
      }


      // Get ID from the location header if it's there
      if (this.new_record() && transport.status == 201) {
        loc = transport.getResponseHeader("location");
        if (loc) {
          id = parseInt(loc.match(/\/([^\/]*?)(\.\w+)?$/)[1]);
          if (!isNaN(id))
            this._setProperty("id", id)
        }
      }

      return (transport.status >= 200 && transport.status < 300 && this.errors.length == 0);
    }.bind(this);
  
    // reset errors
    this._setErrors([]);
  
    var url = null;
    var method = null;
    
    // distinguish between create and update
    if (this.new_record()) {
      url = this._plural_url();
      method = "post";
    }
    else {
      url = this._singular_url();
      method = "put";
    }
    
    // collect params
    var params = {};
    (this._properties).each(function(value, i) {
      params[this._singular + "[" + value + "]"] = this[value];
    }.bind(this));
    
    // send the request
    return Base.request(saveWork, url, {parameters: params, method: method}, callback);
  },
  
  setAttributes : function(attributes)
  {
    $H(attributes).each(function(attr){ this._setAttribute(attr.key, attr.value) }.bind(this));
    return attributes;
  },
  
  updateAttributes : function(attributes, callback)
  {
    $H(attributes).each(function(attr){ this._setAttribute(attr.key, attr.value) }.bind(this));
    return this.save(callback);
  },
  
  // mimics ActiveRecord's behavior of omitting associations, but keeping foreign keys
  attributes : function(include_associations) {
    var attributes = {}
    for (var i=0; i<this._properties.length; i++)
      attributes[this._properties[i]] = this[this._properties[i]];
    if (include_associations) {
      for (var i=0; i<this._associations.length; i++)
        attributes[this._associations[i]] = this[this._associations[i]];
    }
    return attributes;
  },
    
  
  /*
    Internal methods.
  */
  
  _errorsFromTree : function(elements) {
  
    var errors = [];
    if (typeof(elements.error) == "string")
      elements.error = [elements.error];
    
    elements.error.each(function(value, index) {
      errors.push(value);
    });
    
    return errors;
  },
  
  // Sets errors with an array.  Could be extended at some point to include breaking error messages into pairs (attribute, msg).
  _setErrors : function(errors) {
    this.errors = errors;
  },
  
  // Converts the XML tree returned from a single object into a hash of attribute values
  _attributesFromTree : function(elements) {
    var attributes = {}
    for (var attr in elements) {
      // pull out the value
      var value = elements[attr];
      if (elements[attr] && elements[attr]["@type"]) {
        if (elements[attr]["#text"])
          value = elements[attr]["#text"];
        else
          value = undefined;
      }
      
      // handle empty value (pass it through)
      if (!value) {}
      
      // handle scalars
      else if (typeof(value) == "string") {
        // perform any useful type transformations
        if (elements[attr]["@type"] == "integer") {
          var num = parseInt(value);
          if (!isNaN(num)) value = num;
        }
        else if (elements[attr]["@type"] == "boolean")
          value = (value == "true");
        else if (elements[attr]["@type"] == "datetime") {
          var date = Date.parse(value);
          if (!isNaN(date)) value = date;
        }
      }
      // handle arrays (associations)
      else {
        var relation = value; // rename for clarity in the context of an association
        
        // first, detect if it's has_one/belongs_to, or has_many
        var i = 0;
        var singular = null;
        var has_many = false;
        for (var val in relation) {
          if (i == 0)
            singular = val;
          i += 1;
        }
        
        
        // has_many
        if (relation[singular] && typeof(relation[singular]) == "object" && i == 1) {
          var value = [];
          var plural = attr;
          var name = singular.capitalize();
          
          // force array
          if (!(elements[plural][singular].length > 0))
            elements[plural][singular] = [elements[plural][singular]];
          
          elements[plural][singular].each(function(single) {
            if (typeof(name) == "undefined") Base.model(name, {prefix: this._prefix, singular: this._singular, plural: this._plural});
            var base = eval(name + ".build(this._attributesFromTree(single), {checkNew: false})");
            value.push(base);
          }.bind(this));
        }
        // has_one or belongs_to
        else {
          singular = attr;
          var name = singular.capitalize();
          value = this.build(this._attributesFromTree(value), name, this._prefix, singular);
        }
      }
      
      // transform attribute name if needed
      attribute = attr.replace(/-/, "_");
      attributes[attribute] = value;
    }
    
    return attributes;
  },
  
  
  // Sets all attributes and associations at once
  // Deciding between the two on whether the attribute is a complex object or a scalar
  _setAttributes : function(attributes) {
    this._clear();
    for (var attr in attributes)
      this._setAttribute(attr, attributes[attr]);
  },
  
  _setAttribute : function(attribute, value) {
    if (typeof(value) == "object" && value.constructor != Date)
      this._setAssociation(attribute, value);
    else
      this._setProperty(attribute, value);
  },
  
  _setProperties : function(properties) {
    this._clearProperties();
    for (var prop in properties)
      this._setProperty(prop, properties[prop])
  },
  
  _setAssociations : function(associations) {
    this._clearAssociations();
    for (var assoc in associations)
      this._setAssociation(assoc, associations[assoc])
  },
      
  _setProperty : function(property, value) {  
    this[property] = value;
    if (!(this._properties.include(property)))
      this._properties.push(property);  
  },
  
  _setAssociation : function(association, value) {
    this[association] = value;
    if (!(this._associations.include(association)))
      this._associations.push(association);
  },
  
  _clear : function() {
    this._clearProperties();
    this._clearAssociations();
  },
  
  _clearProperties : function() {
    for (var i=0; i<this._properties.length; i++)
      this[this._properties[i]] = null;
    this._properties = [];
  },
  
  _clearAssociations : function() {
    for (var i=0; i<this._associations.length; i++)
      this[this._associations[i]] = null;
    this._associations = [];
  },
  
  // helper URLs
  _singular_url : function(id, params) {
    if (typeof(id) == "object" && !params) {
      params = id;
      id = null;
    }
      
    return ((id || this.id) ? this._prefix + "/" + this._plural + "/" + (id || this.id) + ".xml" : "") + this._queryString(params);
  },
  
  _plural_url : function(params) {
    return this._prefix + "/" + this._plural + ".xml" + this._queryString(params);
  },
  
  _new_url : function(params) {
    return this._prefix + "/" + this._plural + "/new.xml" + this._queryString(params);
  },
  
  // coming soon
  _custom_url : function() {
  
  },
  
  _queryString : function(params) {
    if (!params) return "";
    string = "";
    for (var key in params)
      string += (string == "" ? "?" : "&") + key + "=" + params[key]
    return string;
  }

});

// Returns true if the element has more objects beneath it, or just 1 or more attributes.
// It's not perfect, this would mess up if an object had only one attribute, and it was an array.
// For now, this is just one of the difficulties of dealing with ObjTree.
Base.elementHasMany = function(element) {
  var i = 0;
  var singular = null;
  var has_many = false;
  for (var val in element) {
    if (i == 0)
      singular = val;
    i += 1;
  }
  
  return (element[singular] && typeof(element[singular]) == "object" && element[singular].length != null && i == 1);
}

/* 
  Inflector library, contributed graciously to Jester by Ryan Schuft.
  The library in full is a complete port of Rails' Inflector, though Jester only uses its pluralization.
  Its home page can be found at: http://code.google.com/p/inflection-js/
*/

if (!String.prototype.pluralize) String.prototype.pluralize = function(plural) {
  var str=this;
  if(plural)str=plural;
  else {
    var uncountable_words=['equipment','information','rice','money','species','series','fish','sheep','moose'];
    var uncountable=false;
    for(var x=0;!uncountable&&x<uncountable_words.length;x++)uncountable=(uncountable_words[x].toLowerCase()==str.toLowerCase());
    if(!uncountable) {
      var rules=[
        [new RegExp('(m)an$','gi'),'$1en'],
        [new RegExp('(pe)rson$','gi'),'$1ople'],
        [new RegExp('(child)$','gi'),'$1ren'],
        [new RegExp('(ax|test)is$','gi'),'$1es'],
        [new RegExp('(octop|vir)us$','gi'),'$1i'],
        [new RegExp('(alias|status)$','gi'),'$1es'],
        [new RegExp('(bu)s$','gi'),'$1ses'],
        [new RegExp('(buffal|tomat)o$','gi'),'$1oes'],
        [new RegExp('([ti])um$','gi'),'$1a'],
        [new RegExp('sis$','gi'),'ses'],
        [new RegExp('(?:([^f])fe|([lr])f)$','gi'),'$1$2ves'],
        [new RegExp('(hive)$','gi'),'$1s'],
        [new RegExp('([^aeiouy]|qu)y$','gi'),'$1ies'],
        [new RegExp('(x|ch|ss|sh)$','gi'),'$1es'],
        [new RegExp('(matr|vert|ind)ix|ex$','gi'),'$1ices'],
        [new RegExp('([m|l])ouse$','gi'),'$1ice'],
        [new RegExp('^(ox)$','gi'),'$1en'],
        [new RegExp('(quiz)$','gi'),'$1zes'],
        [new RegExp('s$','gi'),'s'],
        [new RegExp('$','gi'),'s']
      ];
      var matched=false;
      for(var x=0;!matched&&x<=rules.length;x++) {
        matched=str.match(rules[x][0]);
        if(matched)str=str.replace(rules[x][0],rules[x][1]);
      }
    }
  }
  return str;
};

/*

This is a lighter form of ObjTree, with parts Jester doesn't use removed.
Compressed using http://dean.edwards.name/packer/.
Homepage: http://www.kawa.net/works/js/xml/objtree-e.html

XML.ObjTree -- XML source code from/to JavaScript object like E4X

Copyright (c) 2005-2006 Yusuke Kawasaki. All rights reserved.
This program is free software; you can redistribute it and/or
modify it under the Artistic license. Or whatever license I choose,
which I will do instead of keeping this documentation like it is.

*/

eval(function(p,a,c,k,e,r){e=function(c){return(c<a?'':e(parseInt(c/a)))+((c=c%a)>35?String.fromCharCode(c+29):c.toString(36))};if(!''.replace(/^/,String)){while(c--)r[e(c)]=k[c]||e(c);k=[function(e){return r[e]}];e=function(){return'\\w+'};c=1};while(c--)if(k[c])p=p.replace(new RegExp('\\b'+e(c)+'\\b','g'),k[c]);return p}('5(p(o)==\'w\')o=v(){};o.r=v(){m 9};o.r.1i="0.1b";o.r.u.14=\'<?L 1s="1.0" 1o="1n-8" ?>\\n\';o.r.u.Y=\'-\';o.r.u.1c=\'1a/L\';o.r.u.N=v(a){6 b;5(W.U){6 c=K U();6 d=c.1r(a,"1p/L");5(!d)m;b=d.A}q 5(W.10){c=K 10(\'1k.1h\');c.1g=z;c.1e(a);b=c.A}5(!b)m;m 9.E(b)};o.r.u.1d=v(c,d,e){6 f={};y(6 g 19 d){f[g]=d[g]}5(!f.M){5(p(f.18)=="w"&&p(f.17)=="w"&&p(f.16)=="w"){f.M="15"}q{f.M="13"}}5(e){f.X=V;6 h=9;6 i=e;6 j=f.T;f.T=v(a){6 b;5(a&&a.x&&a.x.A){b=h.E(a.x.A)}q 5(a&&a.J){b=h.N(a.J)}i(b,a);5(j)j(a)}}q{f.X=z}6 k;5(p(S)!="w"&&S.I){f.1q=c;6 l=K S.I(f);5(l)k=l.12}q 5(p(Q)!="w"&&Q.I){6 l=K Q.I(c,f);5(l)k=l.12}5(e)m k;5(k&&k.x&&k.x.A){m 9.E(k.x.A)}q 5(k&&k.J){m 9.N(k.J)}};o.r.u.E=v(a){5(!a)m;9.H={};5(9.P){y(6 i=0;i<9.P.t;i++){9.H[9.P[i]]=1}}6 b=9.O(a);5(9.H[a.F]){b=[b]}5(a.B!=11){6 c={};c[a.F]=b;b=c}m b};o.r.u.O=v(a){5(a.B==7){m}5(a.B==3||a.B==4){6 b=a.G.1j(/[^\\1f-\\1l]/);5(b==1m)m z;m a.G}6 c;6 d={};5(a.D&&a.D.t){c={};y(6 i=0;i<a.D.t;i++){6 e=a.D[i].F;5(p(e)!="Z")C;6 f=a.D[i].G;5(!f)C;e=9.Y+e;5(p(d[e])=="w")d[e]=0;d[e]++;9.R(c,e,d[e],f)}}5(a.s&&a.s.t){6 g=V;5(c)g=z;y(6 i=0;i<a.s.t&&g;i++){6 h=a.s[i].B;5(h==3||h==4)C;g=z}5(g){5(!c)c="";y(6 i=0;i<a.s.t;i++){c+=a.s[i].G}}q{5(!c)c={};y(6 i=0;i<a.s.t;i++){6 e=a.s[i].F;5(p(e)!="Z")C;6 f=9.O(a.s[i]);5(f==z)C;5(p(d[e])=="w")d[e]=0;d[e]++;9.R(c,e,d[e],f)}}}m c};o.r.u.R=v(a,b,c,d){5(9.H[b]){5(c==1)a[b]=[];a[b][a[b].t]=d}q 5(c==1){a[b]=d}q 5(c==2){a[b]=[a[b],d]}q{a[b][a[b].t]=d}};',62,91,'|||||if|var|||this|||||||||||||return||XML|typeof|else|ObjTree|childNodes|length|prototype|function|undefined|responseXML|for|false|documentElement|nodeType|continue|attributes|parseDOM|nodeName|nodeValue|__force_array|Request|responseText|new|xml|method|parseXML|parseElement|force_array|Ajax|addNode|HTTP|onComplete|DOMParser|true|window|asynchronous|attr_prefix|string|ActiveXObject||transport|post|xmlDecl|get|parameters|postbody|postBody|in|text|24|overrideMimeType|parseHTTP|loadXML|x00|async|XMLDOM|VERSION|match|Microsoft|x20|null|UTF|encoding|application|uri|parseFromString|version'.split('|'),0,{}))

/*

This is a Date parsing library by Nicholas Barthelemy, packed to keep jester.js light.
Homepage: https://svn.nbarthelemy.com/date-js/
Compressed using http://dean.edwards.name/packer/.

*/

eval(function(p,a,c,k,e,r){e=function(c){return(c<a?'':e(parseInt(c/a)))+((c=c%a)>35?String.fromCharCode(c+29):c.toString(36))};if(!''.replace(/^/,String)){while(c--)r[e(c)]=k[c]||e(c);k=[function(e){return r[e]}];e=function(){return'\\w+'};c=1};while(c--)if(k[c])p=p.replace(new RegExp('\\b'+e(c)+'\\b','g'),k[c]);return p}('N.q.F||(N.q.F=t(a){o u.1d().F(a)});O.q.F||(O.q.F=t(a){o\'0\'.1H(a-u.K)+u});O.q.1H||(O.q.1H=t(a){v s=\'\',i=0;2k(i++<a){s+=u}o s});N.q.1j||(N.q.1j=t(){o u.1d().1j()});O.q.1j||(O.q.1j=t(){v n=u,l=n.K,i=-1;2k(i++<l){u.20(i,i+1)==0?n=n.20(1,n.K):i=l}o n});k.1m="2H 2F 2z 2y 2x 2u 2r 3q 3n 3k 3i 3d".1x(" ");k.1o="38 35 2Y 2U 2Q 2O 2M".1x(" ");k.2K="31 28 31 30 31 30 31 31 30 31 30 31".1x(" ");k.1A={2G:"%Y-%m-%d %H:%M:%S",2w:"%Y-%m-%2v%H:%M:%S%T",2s:"%a, %d %b %Y %H:%M:%S %Z",3p:"%d %b %H:%M",3o:"%B %d, %Y %H:%M"};k.3l=-1;k.3j=-2;(t(){v d=k;d["3h"]=1;d["2i"]=1t;d["2h"]=d["2i"]*19;d["2e"]=d["2h"]*19;d["P"]=d["2e"]*24;d["37"]=d["P"]*7;d["34"]=d["P"]*31;d["1q"]=d["P"]*2X;d["2W"]=d["1q"]*10;d["2R"]=d["1q"]*23;d["2P"]=d["1q"]*1t})();k.q.1D||(k.q.1D=t(){o D k(u.1k())});k.q.26||(k.q.26=t(a,b){u.1F(u.1k()+((a||k.P)*(b||1)));o u});k.q.2a||(k.q.2a=t(a,b){u.1F(u.1k()-((a||k.P)*(b||1)));o u});k.q.1Z||(k.q.1Z=t(){u.1Y(0);u.1X(0);u.1U(0);u.1T(0);o u});k.q.1I||(k.q.1I=t(a,b){C(1i a==\'1p\')a=k.1J(a);o 18.2l((u.1k()-a.1k())/(b|k.P))});k.q.1N||(k.q.1N=k.q.1I);k.q.2n||(k.q.2n=t(){d=O(u);o d.1f(-(18.1y(d.K,2)))>3&&d.1f(-(18.1y(d.K,2)))<21?"V":["V","17","16","1a","V"][18.1y(N(d)%10,4)]});k.q.1w||(k.q.1w=t(){v f=(D k(u.1h(),0,1)).1e();o 18.2t((u.1n()+(f>3?f-4:f+3))/7)});k.q.1M=t(){o u.1d().1v(/^.*? ([A-Z]{3}) [0-9]{4}.*$/,"$1").1v(/^.*?\\(([A-Z])[a-z]+ ([A-Z])[a-z]+ ([A-Z])[a-z]+\\)$/,"$1$2$3")};k.q.2p=t(){o(u.1u()>0?"-":"+")+O(18.2l(u.1u()/19)).F(2)+O(u.1u()%19,2,"0").F(2)};k.q.1n||(k.q.1n=t(){o((k.2o(u.1h(),u.1c(),u.1b()+1,0,0,0)-k.2o(u.1h(),0,1,0,0,0))/k.P)});k.q.2m||(k.q.2m=t(){v a=u.1D();a.15(a.1c()+1);a.L(0);o a.1b()});k.2j||(k.2j=t(a,b){a=(a+12)%12;C(k.1K(b)&&a==1)o 29;o k.3g.3f[a]});k.1K||(k.1K=t(a){o(((a%4)==0)&&((a%23)!=0)||((a%3e)==0))});k.q.1B||(k.q.1B=t(c){C(!u.3c())o\'&3b;\';v d=u;C(k.1A[c.2g()])c=k.1A[c.2g()];o c.1v(/\\%([3a])/g,t(a,b){39(b){E\'a\':o k.1l(d.1e()).1f(0,3);E\'A\':o k.1l(d.1e());E\'b\':o k.13(d.1c()).1f(0,3);E\'B\':o k.13(d.1c());E\'c\':o d.1d();E\'d\':o d.1b().F(2);E\'H\':o d.1G().F(2);E\'I\':o((h=d.1G()%12)?h:12).F(2);E\'j\':o d.1n().F(3);E\'m\':o(d.1c()+1).F(2);E\'M\':o d.36().F(2);E\'p\':o d.1G()<12?\'33\':\'32\';E\'S\':o d.2Z().F(2);E\'U\':o d.1w().F(2);E\'W\':R Q("%W 2V 2T 2S 25");E\'w\':o d.1e();E\'x\':o d.1r("%m/%d/%Y");E\'X\':o d.1r("%I:%M%p");E\'y\':o d.1h().1d().1f(2);E\'Y\':o d.1h();E\'T\':o d.2p();E\'Z\':o d.1M()}})});k.q.1r||(k.q.1r=k.q.1B);k.22=k.1J;k.1J=t(a){C(1i a!=\'1p\')o a;C(a.K==0||(/^\\s+$/).1E(a))o;2N(v i=0;i<k.1g.K;i++){v r=k.1g[i].J.2L(a);C(r)o k.1g[i].G(r)}o D k(k.22(a))};k.13||(k.13=t(c){v d=-1;C(1i c==\'2J\'){o k.1m[c.1c()]}2I C(1i c==\'27\'){d=c-1;C(d<0||d>11)R D Q("1s 1C 2b 2q 1W 1V 2d 1 2c 12:"+d);o k.1m[d]}v m=k.1m.1S(t(a,b){C(D 1O("^"+c,"i").1E(a)){d=b;o 1R}o 2f});C(m.K==0)R D Q("1s 1C 1p");C(m.K>1)R D Q("1Q 1C");o k.1m[d]});k.1l||(k.1l=t(c){v d=-1;C(1i c==\'27\'){d=c-1;C(d<0||d>6)R D Q("1s 1z 2b 2q 1W 1V 2d 1 2c 7");o k.1o[d]}v m=k.1o.1S(t(a,b){C(D 1O("^"+c,"i").1E(a)){d=b;o 1R}o 2f});C(m.K==0)R D Q("1s 1z 1p");C(m.K>1)R D Q("1Q 1z");o k.1o[d]});k.1g||(k.1g=[{J:/(\\d{1,2})\\/(\\d{1,2})\\/(\\d{2,4})/,G:t(a){v d=D k();d.1L(a[3]);d.L(14(a[2],10));d.15(14(a[1],10)-1);o d}},{J:/(\\d{4})(?:-?(\\d{2})(?:-?(\\d{2})(?:[T ](\\d{2})(?::?(\\d{2})(?::?(\\d{2})(?:\\.(\\d+))?)?)?(?:Z|(?:([-+])(\\d{2})(?::?(\\d{2}))?)?)?)?)?)?/,G:t(a){v b=0;v d=D k(a[1],0,1);C(a[2])d.15(a[2]-1);C(a[3])d.L(a[3]);C(a[4])d.1Y(a[4]);C(a[5])d.1X(a[5]);C(a[6])d.1U(a[6]);C(a[7])d.1T(N("0."+a[7])*1t);C(a[9]){b=(N(a[9])*19)+N(a[10]);b*=((a[8]==\'-\')?1:-1)}b-=d.1u();1P=(N(d)+(b*19*1t));d.1F(N(1P));o d}},{J:/^2E/i,G:t(){o D k()}},{J:/^2D/i,G:t(){v d=D k();d.L(d.1b()+1);o d}},{J:/^2C/i,G:t(){v d=D k();d.L(d.1b()-1);o d}},{J:/^(\\d{1,2})(17|16|1a|V)?$/i,G:t(a){v d=D k();d.L(14(a[1],10));o d}},{J:/^(\\d{1,2})(?:17|16|1a|V)? (\\w+)$/i,G:t(a){v d=D k();d.L(14(a[1],10));d.15(k.13(a[2]));o d}},{J:/^(\\d{1,2})(?:17|16|1a|V)? (\\w+),? (\\d{4})$/i,G:t(a){v d=D k();d.L(14(a[1],10));d.15(k.13(a[2]));d.1L(a[3]);o d}},{J:/^(\\w+) (\\d{1,2})(?:17|16|1a|V)?$/i,G:t(a){v d=D k();d.L(14(a[2],10));d.15(k.13(a[1]));o d}},{J:/^(\\w+) (\\d{1,2})(?:17|16|1a|V)?,? (\\d{4})$/i,G:t(a){v d=D k();d.L(14(a[2],10));d.15(k.13(a[1]));d.1L(a[3]);o d}},{J:/^3m (\\w+)$/i,G:t(a){v d=D k();v b=d.1e();v c=k.1l(a[1]);v e=c-b;C(c<=b){e+=7}d.L(d.1b()+e);o d}},{J:/^2B (\\w+)$/i,G:t(a){R D Q("2A 25 3r");}}]);',62,214,'||||||||||||||||||||Date||||return||prototype|||function|this|var|||||||if|new|case|zf|handler|||re|length|setDate||Number|String|DAY|Error|throw||||th||||||||parseMonth|parseInt|setMonth|nd|st|Math|60|rd|getDate|getMonth|toString|getDay|substr|__PARSE_PATTERNS|getFullYear|typeof|rz|getTime|parseDay|MONTH_NAMES|getDayOfYear|DAY_NAMES|string|YEAR|format|Invalid|1000|getTimezoneOffset|replace|getWeek|split|min|day|FORMATS|strftime|month|clone|test|setTime|getHours|str|diff|parse|isLeapYear|setYear|getTimezone|compare|RegExp|time|Ambiguous|true|findAll|setMilliseconds|setSeconds|be|must|setMinutes|setHours|clearTime|substring||__native_parse|100||yet|increment|number|||decrement|index|and|between|HOUR|false|toLowerCase|MINUTE|SECOND|daysInMonth|while|floor|lastDayOfMonth|getOrdinal|UTC|getGMTOffset|value|July|rfc822|round|June|dT|iso8601|May|April|March|Not|last|yes|tom|tod|February|db|January|else|object|DAYS_PER_MONTH|exec|Saturday|for|Friday|MILLENNIUM|Thursday|CENTURY|supported|not|Wednesday|is|DECADE|365|Tuesday|getSeconds|||PM|AM|MONTH|Monday|getMinutes|WEEK|Sunday|switch|aAbBcdHIjmMpSUWwxXyYTZ|nbsp|valueOf|December|400|DAYS_IN_MONTH|Convensions|MILLISECOND|November|ERA|October|EPOCH|next|September|long|short|August|implemented'.split('|'),0,{}))
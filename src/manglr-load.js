(function(doc, manglr){
  "use strict";

  function init() {
    var tpl = manglr.compile(doc);
    manglr.bind_doc(doc, tpl, manglr.data);
    doc = manglr = null; // GC.
  }
  if (doc.readyState == 'loading') {
    // defer until (non-async) scripts have loaded so manglr plugins can register.
    doc.addEventListener('DOMContentLoaded', init);
  } else {
    setTimeout(0, init);
  }

})(document, manglr);

var _jsxWrapper = function _jsxWrapper(func, args) {
  var wrapper = args ? function wrapper() {
    return func.apply(this, args);
  } : func;
  wrapper.__jsxDOMWrapper = true;
  return wrapper;
};

var _hasOwn = Object.prototype.hasOwnProperty;

var _forOwn = function _forOwn(object, iterator) {
  for (var prop in object) {
    if (_hasOwn.call(object, prop)) iterator(object[prop], prop);
  }
};

var _renderArbitrary = function _renderArbitrary(child) {
  var type = typeof child;

  if (type === "number" || type === "string" || child && child instanceof String) {
    text(child);
  } else if (type === "function" && child.__jsxDOMWrapper) {
    child();
  } else if (Array.isArray(child)) {
    child.forEach(_renderArbitrary);
  } else if (String(child) === "[object Object]") {
    _forOwn(child, _renderArbitrary);
  }
};

function render() {
  var mapNested4 = [1, 2, 3].map(function (i) {
    elementOpen("outer4");
    elementOpen("inner4", null, null, "attr", _jsxWrapper(function (_i, _i2) {
      elementOpen("span", null, null, "attr", _i);

      _renderArbitrary(_i2);

      return elementClose("span");
    }, [i, i]));
    elementClose("inner4");
    return elementClose("outer4");
  });
}
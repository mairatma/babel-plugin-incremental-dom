import inject from "../inject";
import injectHasOwn from "./has-own";
import toFunctionCall from "../ast/to-function-call";
import toFunctionCallStatement from "../ast/to-function-call-statement";

// Loops over all own properties, calling
// the specified iterator function with
// value and prop name.
// Depends on the _hasOwn helper.
function forOwnAST(t, plugin, ref, deps) {
  const hasOwn = deps.hasOwn;
  const object = t.identifier("object");
  const iterator = t.identifier("iterator");
  const prop = t.identifier("prop");

  /**
   * function _forOwn(object, iterator) {
   *   for (var prop in object) {
   *     if (hasOwn.call(object, prop)) {
   *       iterator(object[prop], prop);
   *     }
   *   }
   * }
   */
  return t.functionExpression(
    ref,
    [object, iterator],
    t.blockStatement([
      t.forInStatement(
        t.variableDeclaration("var", [t.variableDeclarator(prop)]),
        object,
        t.ifStatement(
          toFunctionCall(t, t.memberExpression(
            hasOwn,
            t.identifier("call")
          ), [object, prop]),
          toFunctionCallStatement(t, iterator, [
            t.memberExpression(object, prop, true),
            prop
          ])
        )
      )
    ])
  );
}

export default function injectForOwn(t, plugin) {
  return inject(t, plugin, "forOwn", forOwnAST, {
    hasOwn: injectHasOwn
  });
}

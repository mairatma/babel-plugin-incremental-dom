import isLiteralOrUndefined from "./ast/is-literal-or-undefined";

function addClosureVar(expression, closureVars) {
  const arg = expression.node;
  const param = expression.scope.generateUidIdentifierBasedOnNode(arg);

  closureVars.push({ param, arg });
  expression.replaceWith(param);
}

function last(array) {
  return array[array.length - 1];
}

// Extracts variable expressions into an array of closure parameters,
// so that when the closure is finally evaluated, it will have the correct
// values.
const expressionExtractor = {
  JSXSpreadAttribute: {
    enter(path) {
      const { closureVarsStack } = this;
      addClosureVar(path.get("argument"), last(closureVarsStack));
    }
  },

  JSXExpressionContainer: {
    enter(path) {
      const expression = path.get("expression");
      // If the variable is constant (or will be wrapped), don't extract.
      if (isLiteralOrUndefined(expression) || expression.isJSXElement()) {
        return;
      }

      const { closureVarsStack } = this;

      addClosureVar(expression, last(closureVarsStack));
    }
  }
};

export default expressionExtractor;

import isRootJSX from "./helpers/is-root-jsx";
import isChildElement from "./helpers/is-child-element";
import { setupInjector, injectHelpers } from "./helpers/inject";
import { setupHoists, hoist, addHoistedDeclarator } from "./helpers/hoist";

import expressionExtractor from "./helpers/extract-expressions";

import injectJSXWrapper from "./helpers/runtime/jsx-wrapper";

import toFunctionCall from "./helpers/ast/to-function-call";
import flattenExpressions from "./helpers/ast/flatten-expressions";
import statementsWithReturnLast from "./helpers/ast/statements-with-return-last";

import elementOpenCall from "./helpers/element-open-call";
import elementCloseCall from "./helpers/element-close-call";
import buildChildren from "./helpers/build-children";


export default function ({ types: t, traverse: _traverse }) {
  function traverse(path, visitor, state) {
    _traverse.visitors.explode(visitor);

    const { node } = path;
    if (!node) {
      return;
    }

    const { type } = node;
    const { enter = [], exit = [] } = visitor[type] || {};

    enter.forEach((fn) => fn.call(state, path, state));
    if (!path.shouldSkip) {
      path.traverse(visitor, state);
      exit.forEach((fn) => fn.call(state, path, state));
    }
    path.shouldSkip = false;
  }

  const elementVisitor = {
    JSXNamespacedName(path) {
      throw path.buildCodeFrameError("JSX Namespaces aren't supported.");
    },

    JSXElement: {
      enter(path) {
        let { secondaryTree, root, replacedElements, closureVarsStack } = this;
        const needsWrapper = root !== path && !isChildElement(path);

        // If this element needs to be wrapped in a closure, we need to transform
        // it's children without wrapping them.
        if (secondaryTree || needsWrapper) {
          // If this element needs a closure wrapper, we need a new array of
          // closure parameters. Otherwise, use the parent's, since it may need
          // a closure wrapper.
          closureVarsStack.push([]);

          const { opts, file } = this;
          const state = { secondaryTree: false, root: path, replacedElements, closureVarsStack, opts, file };
          path.traverse(expressionExtractor, state);
          path.traverse(elementVisitor, state);
        }
      },

      exit(path) {
        const { root, secondaryTree, replacedElements, closureVarsStack } = this;
        const isChild = isChildElement(path);
        const needsWrapper = root !== path && !isChild;

        const { parentPath } = path;
        const explicitReturn = parentPath.isReturnStatement();
        const implicitReturn = parentPath.isArrowFunctionExpression();

        const openingElement = elementOpenCall(t, path.get("openingElement"), this);
        const closingElement = elementCloseCall(t, path.get("openingElement"), this);
        const children = buildChildren(t, path.get("children"), this);

        let elements = [ openingElement, ...children ];
        if (closingElement) { elements.push(closingElement); }

        // Expressions Containers must contain an expression and not statements.
        // This will be flattened out into statements later.
        if (isChild) {
          const sequence = t.sequenceExpression(elements);
          // Mark this sequence as a JSX Element so we can avoid an unnecessary
          // renderArbitrary call.
          replacedElements.add(sequence);
          path.replaceWith(sequence);
          return;
        }

        if (explicitReturn || implicitReturn || secondaryTree || needsWrapper) {
          // Transform (recursively) any sequence expressions into a series of
          // statements.
          elements = flattenExpressions(t, elements);

          // Ensure the last statement returns the DOM element.
          elements = statementsWithReturnLast(t, elements);
        }

        if (secondaryTree || needsWrapper) {
          // Create a wrapper around our element, and mark it as a one so later
          // child expressions can identify and "render" it.
          const closureVars = closureVarsStack.pop();
          const params = closureVars.map((e) => e.param);
          let wrapper = t.functionExpression(null, params, t.blockStatement(elements));

          if (this.opts.hoist) {
            wrapper = addHoistedDeclarator(t, path.scope, "wrapper", wrapper, this);
          }

          const args = [ wrapper ];
          if (closureVars.length) {
            const paramArgs = closureVars.map((e) => e.arg);
            args.push(t.arrayExpression(paramArgs));
          }

          const wrapperCall = toFunctionCall(t, injectJSXWrapper(t, this), args);
          replacedElements.add(wrapperCall);
          path.replaceWith(wrapperCall);
          return;
        }

        // This is the main JSX element. Replace the return statement
        // with all the nested calls, returning the main JSX element.
        if (explicitReturn) {
          parentPath.replaceWithMultiple(elements);
        } else {
          path.replaceWithMultiple(elements);
        }
      }
    }
  };

  const rootElementVisitor = {
    JSXElement(path) {
      const isRoot = isRootJSX(path);

      if (isRoot) {
        const { parentPath } = path;
        const { opts, file } = this;
        const secondaryTree = !(parentPath.isReturnStatement() || parentPath.isArrowFunctionExpression());
        const replacedElements = new Set();
        const closureVarsStack = [];

        const state = {
          root: path,
          secondaryTree,
          replacedElements,
          closureVarsStack,
          opts,
          file
        };

        traverse(path, elementVisitor, state);
      } else {
        path.skip();
      }
    }
  };

  // This visitor first finds the root element, and ignores all the others.
  return {
    manipulateOptions(opts, parserOpts) {
      parserOpts.plugins.push("jsx");
    },
    visitor: {
      Program: {
        enter() {
          setupInjector(this);
          setupHoists(this);
        },

        exit(path) {
          hoist(t, path, this);
          injectHelpers(this);
        }
      },

      Function: {
        exit(path) {
          path.traverse(rootElementVisitor, this);

          const { opts, file } = this;
          const secondaryTree = true;
          const replacedElements = new Set();
          const closureVarsStack = [];

          const state = {
            root: path,
            secondaryTree,
            replacedElements,
            closureVarsStack,
            opts,
            file
          };

          path.traverse(elementVisitor, state);
        }
      }
    }
  };
}

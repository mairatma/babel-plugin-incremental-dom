import toFunctionCall from "./ast/to-function-call";
import toReference from "./ast/to-reference";

import getOption from "./get-option";
import iDOMMethod from "./idom-method";
import attrsToAttrCalls from "./attributes-to-attr-calls";
import buildChildren from "./build-children";
import extractOpenArguments from "./extract-open-arguments";
import flattenExpressions from "./flatten-expressions";
import statementsWithReturnLast from "./statements-with-return-last";
import replaceArrow from "./replace-arrow";
import { setupHoists, hoistStatics } from "./hoist-statics";
import eagerlyDeclare from "./eagerly-declare";

import { setupInjector } from "./inject";
import injectJSXWrapper from "./runtime/jsx-wrapper";

export default {
    Program: {
      enter: [setupInjector, setupHoists],

      exit(program, parent, scope, file) {
        hoistStatics(t, file, this);
      }
    },

    JSXElement: {
      enter(node) {
        let inAssignment = false;
        let inAttribute = false;
        let inCallExpression = false;
        let inCollection = false;
        let inReturnStatement = false;
        let containingJSXElement;
        let last = node;

        this.findParent((path) => {
          if (path.isJSXElement()) {
            containingJSXElement = path;
            return true;
          }
          if (path.isArrowFunctionExpression()) {
            inReturnStatement = inReturnStatement || path.get("body").isExpression();
            return true;
          }
          if (path.isFunction() || path.isProgram()) {
            return true;
          }
          if (path.isSequenceExpression()) {
            const expressions = path.node.expressions;
            const index = expressions.indexOf(last);
            if (index !== expressions.length - 1) {
              return true;
            }
          }
          if (path.isJSXAttribute()) {
            inAttribute = true;
          } else if (path.isAssignmentExpression() || path.isVariableDeclarator()) {
            inAssignment = true;
          } else if (path.isArrayExpression() || path.isObjectExpression()) {
            inCollection = true;
          } else if (path.isReturnStatement()) {
            inReturnStatement = true;
          } else if (path.isCallExpression()) {
            inCallExpression = true;
          }
          last = path.node;
        });

        // Values are useless if they aren't assigned.
        // ```
        //   var a = 1;
        //   <div /> // Useless JSX node
        // ```
        if (!(inReturnStatement || inAssignment || inCallExpression || containingJSXElement)) {
          throw this.errorWithNode("Unused JSX Elements aren't supported.");
        }

        const containerNeedsWrapper = (containingJSXElement) ?
          containingJSXElement.getData("containerNeedsWrapper") || containingJSXElement.getData("needsWrapper") :
          false;
        let needsWrapper = inAttribute || inAssignment || inCollection || inCallExpression;
        if (!containingJSXElement && !needsWrapper) {
          // Determine if there are JSXElements in a higher scope.
          needsWrapper = !isRootJSX(this);
        }

        // Tie a child JSXElement's eager declarations with the parent's, so
        // so all declarations come before the element.
        const eagerDeclarators = (containingJSXElement) ?
          containingJSXElement.getData("eagerDeclarators") :
          [];
        const staticAssignments = (containingJSXElement) ?
          containingJSXElement.getData("staticAssignments") :
          [];

        this.setData("containerNeedsWrapper", containerNeedsWrapper);
        this.setData("containingJSXElement", containingJSXElement);
        this.setData("eagerDeclarators", eagerDeclarators);
        this.setData("needsWrapper", needsWrapper);
        this.setData("staticAssignments", staticAssignments);
      },

      exit(node, parent, scope, file) {
        const {
          containerNeedsWrapper,
          containingJSXElement,
          eagerDeclarators,
          staticAssignments,
          needsWrapper,
        } = this.data;

        const eager = needsWrapper || containerNeedsWrapper;
        const explicitReturn = t.isReturnStatement(parent);
        const implicitReturn = t.isArrowFunctionExpression(parent);

        // Filter out empty children, and transform JSX expressions
        // into normal expressions.
        const openingElement = node.openingElement;
        const closingElement = node.closingElement;

        const {
          children,
          eagerChildren
        } = buildChildren(t, scope, file, node.children, { eager });

        eagerDeclarators.push(...eagerChildren);

        let elements = [ openingElement, ...children ];
        if (closingElement) { elements.push(closingElement); }

        // If we're inside a JSX node, flattening expressions
        // may force us into an unwanted function scope.
        if (t.isJSXElement(parent)) {
          return elements;
        }

        // Expressions Containers must contain an expression and not statements.
        // This will be flattened out into statements later.
        if (containingJSXElement && !needsWrapper) {
          const sequence = t.sequenceExpression(elements);
          // Mark this sequence as a JSX Element so we can avoid an unnecessary
          // renderArbitrary call.
          sequence._iDOMwasJSX = true;
          return sequence;
        }

        if (explicitReturn || implicitReturn || needsWrapper) {
          // Transform (recursively) any sequence expressions into a series of
          // statements.
          elements = flattenExpressions(t, elements);

          // Ensure the last statement returns the DOM element.
          elements = statementsWithReturnLast(t, elements);
        }

        if (!containingJSXElement && eagerDeclarators.length) {
          eagerlyDeclare(t, scope, this, eagerDeclarators);
        }

        if (!containingJSXElement && staticAssignments.length) {
          elements = [...staticAssignments, ...elements];
        }

        if (needsWrapper) {
          // Create a wrapper around our element, and mark it as a one so later
          // child expressions can identify and "render" it.
          const jsxWrapperRef = injectJSXWrapper(t, file);
          const wrapper = toFunctionCall(t, jsxWrapperRef, [
            t.functionExpression(null, [], t.blockStatement(elements))
          ]);
          wrapper._iDOMwasJSX = true;
          return wrapper;
        }

        openingElement._iDOMisRoot = true;

        // This is the main JSX element. Replace the return statement
        // with all the nested calls, returning the main JSX element.
        if (implicitReturn) {
          replaceArrow(t, this.parentPath, elements);
        } else if (explicitReturn) {
          this.parentPath.replaceWithMultiple(elements);
        } else {
          return elements;
        }
      }
    },

    JSXOpeningElement: {
      exit(node, parent, scope, file) {
        const tag = toReference(t, node.name);

        const JSXElement = this.parentPath;
        // Only eagerly evaluate our attributes if we will be wrapping the element.
        const eager = JSXElement.getData("needsWrapper") || JSXElement.getData("containerNeedsWrapper");
        const eagerDeclarators = JSXElement.getData("eagerDeclarators");
        const hoist = getOption(file, "hoist");
        const staticAssignments = JSXElement.getData("staticAssignments");

        const {
          key,
          statics,
          attrs,
          attributeDeclarators,
          staticAssignment,
          hasSpread
        } = extractOpenArguments(t, scope, file, node.attributes, { eager, hoist });

        // Push any eager attribute declarators onto the element's list of
        // eager declarations.
        eagerDeclarators.push(...attributeDeclarators);
        if (staticAssignment) {
          staticAssignments.push(staticAssignment);
        }

        // Only push arguments if they're needed
        const args = [tag];
        if (key || statics) {
          args.push(key || t.literal(null));
        }
        if (statics) {
          args.push(statics);
        }

        // If there is a spread element, we need to use
        // the elementOpenStart/elementOpenEnd syntax.
        // This allows spreads to be transformed into
        // attr(name, value) calls.
        if (hasSpread) {
          const attrCalls = attrsToAttrCalls(t, file, attrs);

          const expressions = [
            toFunctionCall(t, iDOMMethod(file, "elementOpenStart"), args),
            ...attrCalls,
            toFunctionCall(t, iDOMMethod(file, "elementOpenEnd"), [tag])
          ];
          if (node.selfClosing) {
            expressions.push(toFunctionCall(t, iDOMMethod(file, "elementClose"), [tag]));
          }

          return t.sequenceExpression(expressions);
        }

        if (attrs) {
          // Only push key and statics if they have not
          // already been pushed.
          if (!statics) {
            if (!key) {
              args.push(t.literal(null));
            }
            args.push(t.literal(null));
          }

          args.push(...attrs);
        }

        const elementFunction = (node.selfClosing) ? "elementVoid" : "elementOpen";
        return toFunctionCall(t, iDOMMethod(file, elementFunction), args);
      }
    },

    JSXClosingElement: {
      exit(node, parent, scope, file) {
        return toFunctionCall(t, iDOMMethod(file, "elementClose"), [toReference(t, node.name)]);
      }
    },

  }
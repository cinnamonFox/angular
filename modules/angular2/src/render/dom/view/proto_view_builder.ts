import {isPresent, isBlank, BaseException, StringWrapper} from 'angular2/src/facade/lang';
import {
  ListWrapper,
  MapWrapper,
  Set,
  SetWrapper,
  List,
  StringMapWrapper
} from 'angular2/src/facade/collection';
import {DOM} from 'angular2/src/dom/dom_adapter';

import {
  ASTWithSource,
  AST,
  AstTransformer,
  AccessMember,
  LiteralArray,
  ImplicitReceiver
} from 'angular2/src/change_detection/change_detection';

import {DomProtoView, DomProtoViewRef, resolveInternalDomProtoView} from './proto_view';
import {DomElementBinder, Event, HostAction} from './element_binder';
import {ElementSchemaRegistry} from '../schema/element_schema_registry';

import * as api from '../../api';

import {
  NG_BINDING_CLASS,
  EVENT_TARGET_SEPARATOR,
  queryBoundTextNodeIndices,
  camelCaseToDashCase
} from '../util';

export class ProtoViewBuilder {
  variableBindings: Map<string, string> = new Map();
  elements: List<ElementBinderBuilder> = [];
  rootTextBindings: Map<Node, ASTWithSource> = new Map();
  ngContentCount: number = 0;
  hostAttributes: Map<string, string> = new Map();

  constructor(public rootElement, public type: api.ViewType,
              public viewEncapsulation: api.ViewEncapsulation) {}

  bindElement(element: HTMLElement, description: string = null): ElementBinderBuilder {
    var builder = new ElementBinderBuilder(this.elements.length, element, description);
    this.elements.push(builder);
    DOM.addClass(element, NG_BINDING_CLASS);

    return builder;
  }

  bindVariable(name: string, value: string) {
    // Store the variable map from value to variable, reflecting how it will be used later by
    // DomView. When a local is set to the view, a lookup for the variable name will take place
    // keyed
    // by the "value", or exported identifier. For example, ng-for sets a view local of "index".
    // When this occurs, a lookup keyed by "index" must occur to find if there is a var referencing
    // it.
    this.variableBindings.set(value, name);
  }

  // Note: We don't store the node index until the compilation is complete,
  // as the compiler might change the order of elements.
  bindRootText(textNode: Text, expression: ASTWithSource) {
    this.rootTextBindings.set(textNode, expression);
  }

  bindNgContent() { this.ngContentCount++; }

  setHostAttribute(name: string, value: string) { this.hostAttributes.set(name, value); }

  build(schemaRegistry: ElementSchemaRegistry): api.ProtoViewDto {
    var domElementBinders = [];

    var apiElementBinders = [];
    var textNodeExpressions = [];
    var rootTextNodeIndices = [];
    var transitiveNgContentCount = this.ngContentCount;
    queryBoundTextNodeIndices(DOM.content(this.rootElement), this.rootTextBindings,
                              (node, nodeIndex, expression) => {
                                textNodeExpressions.push(expression);
                                rootTextNodeIndices.push(nodeIndex);
                              });

    ListWrapper.forEach(this.elements, (ebb: ElementBinderBuilder) => {
      var directiveTemplatePropertyNames = new Set();
      var apiDirectiveBinders = ListWrapper.map(ebb.directives, (dbb: DirectiveBuilder) => {
        ebb.eventBuilder.merge(dbb.eventBuilder);
        ListWrapper.forEach(dbb.templatePropertyNames,
                            (name) => directiveTemplatePropertyNames.add(name));
        return new api.DirectiveBinder({
          directiveIndex: dbb.directiveIndex,
          propertyBindings: dbb.propertyBindings,
          eventBindings: dbb.eventBindings,
          hostPropertyBindings: buildElementPropertyBindings(schemaRegistry, ebb.element, true,
                                                             dbb.hostPropertyBindings, null)
        });
      });
      var nestedProtoView =
          isPresent(ebb.nestedProtoView) ? ebb.nestedProtoView.build(schemaRegistry) : null;
      if (isPresent(nestedProtoView)) {
        transitiveNgContentCount += nestedProtoView.transitiveNgContentCount;
      }
      var parentIndex = isPresent(ebb.parent) ? ebb.parent.index : -1;
      var textNodeIndices = [];
      queryBoundTextNodeIndices(ebb.element, ebb.textBindings, (node, nodeIndex, expression) => {
        textNodeExpressions.push(expression);
        textNodeIndices.push(nodeIndex);
      });
      apiElementBinders.push(new api.ElementBinder({
        index: ebb.index,
        parentIndex: parentIndex,
        distanceToParent: ebb.distanceToParent,
        directives: apiDirectiveBinders,
        nestedProtoView: nestedProtoView,
        propertyBindings:
            buildElementPropertyBindings(schemaRegistry, ebb.element, isPresent(ebb.componentId),
                                         ebb.propertyBindings, directiveTemplatePropertyNames),
        variableBindings: ebb.variableBindings,
        eventBindings: ebb.eventBindings,
        readAttributes: ebb.readAttributes
      }));
      domElementBinders.push(new DomElementBinder({
        textNodeIndices: textNodeIndices,
        hasNestedProtoView: isPresent(nestedProtoView) || isPresent(ebb.componentId),
        hasNativeShadowRoot: false,
        eventLocals: new LiteralArray(ebb.eventBuilder.buildEventLocals()),
        localEvents: ebb.eventBuilder.buildLocalEvents(),
        globalEvents: ebb.eventBuilder.buildGlobalEvents()
      }));
    });
    var rootNodeCount = DOM.childNodes(DOM.content(this.rootElement)).length;
    return new api.ProtoViewDto({
      render: new DomProtoViewRef(
          DomProtoView.create(this.type, this.rootElement, this.viewEncapsulation, [rootNodeCount],
                              rootTextNodeIndices, domElementBinders, this.hostAttributes)),
      type: this.type,
      elementBinders: apiElementBinders,
      variableBindings: this.variableBindings,
      textBindings: textNodeExpressions,
      transitiveNgContentCount: transitiveNgContentCount
    });
  }
}

export class ElementBinderBuilder {
  parent: ElementBinderBuilder = null;
  distanceToParent: number = 0;
  directives: List<DirectiveBuilder> = [];
  nestedProtoView: ProtoViewBuilder = null;
  propertyBindings: Map<string, ASTWithSource> = new Map();
  variableBindings: Map<string, string> = new Map();
  eventBindings: List<api.EventBinding> = [];
  eventBuilder: EventBuilder = new EventBuilder();
  textBindings: Map<Node, ASTWithSource> = new Map();
  readAttributes: Map<string, string> = new Map();
  componentId: string = null;

  constructor(public index: number, public element, description: string) {}

  setParent(parent: ElementBinderBuilder, distanceToParent: number): ElementBinderBuilder {
    this.parent = parent;
    if (isPresent(parent)) {
      this.distanceToParent = distanceToParent;
    }
    return this;
  }

  readAttribute(attrName: string) {
    if (isBlank(this.readAttributes.get(attrName))) {
      this.readAttributes.set(attrName, DOM.getAttribute(this.element, attrName));
    }
  }

  bindDirective(directiveIndex: number): DirectiveBuilder {
    var directive = new DirectiveBuilder(directiveIndex);
    this.directives.push(directive);
    return directive;
  }

  bindNestedProtoView(rootElement: HTMLElement): ProtoViewBuilder {
    if (isPresent(this.nestedProtoView)) {
      throw new BaseException('Only one nested view per element is allowed');
    }
    this.nestedProtoView =
        new ProtoViewBuilder(rootElement, api.ViewType.EMBEDDED, api.ViewEncapsulation.NONE);
    return this.nestedProtoView;
  }

  bindProperty(name: string, expression: ASTWithSource) {
    this.propertyBindings.set(name, expression);
  }

  bindVariable(name: string, value: string) {
    // When current is a view root, the variable bindings are set to the *nested* proto view.
    // The root view conceptually signifies a new "block scope" (the nested view), to which
    // the variables are bound.
    if (isPresent(this.nestedProtoView)) {
      this.nestedProtoView.bindVariable(name, value);
    } else {
      // Store the variable map from value to variable, reflecting how it will be used later by
      // DomView. When a local is set to the view, a lookup for the variable name will take place
      // keyed
      // by the "value", or exported identifier. For example, ng-for sets a view local of "index".
      // When this occurs, a lookup keyed by "index" must occur to find if there is a var
      // referencing
      // it.
      this.variableBindings.set(value, name);
    }
  }

  bindEvent(name: string, expression: ASTWithSource, target: string = null) {
    this.eventBindings.push(this.eventBuilder.add(name, expression, target));
  }

  // Note: We don't store the node index until the compilation is complete,
  // as the compiler might change the order of elements.
  bindText(textNode: Text, expression: ASTWithSource) {
    this.textBindings.set(textNode, expression);
  }

  setComponentId(componentId: string) { this.componentId = componentId; }
}

export class DirectiveBuilder {
  // mapping from directive property name to AST for that directive
  propertyBindings: Map<string, ASTWithSource> = new Map();
  // property names used in the template
  templatePropertyNames: List<string> = [];
  hostPropertyBindings: Map<string, ASTWithSource> = new Map();
  eventBindings: List<api.EventBinding> = [];
  eventBuilder: EventBuilder = new EventBuilder();

  constructor(public directiveIndex: number) {}

  bindProperty(name: string, expression: ASTWithSource, elProp: string) {
    this.propertyBindings.set(name, expression);
    if (isPresent(elProp)) {
      // we are filling in a set of property names that are bound to a property
      // of at least one directive. This allows us to report "dangling" bindings.
      this.templatePropertyNames.push(elProp);
    }
  }

  bindHostProperty(name: string, expression: ASTWithSource) {
    this.hostPropertyBindings.set(name, expression);
  }

  bindEvent(name: string, expression: ASTWithSource, target: string = null) {
    this.eventBindings.push(this.eventBuilder.add(name, expression, target));
  }
}

export class EventBuilder extends AstTransformer {
  locals: List<AST> = [];
  localEvents: List<Event> = [];
  globalEvents: List<Event> = [];
  _implicitReceiver: AST = new ImplicitReceiver();

  constructor() { super(); }

  add(name: string, source: ASTWithSource, target: string): api.EventBinding {
    // TODO(tbosch): reenable this when we are parsing element properties
    // out of action expressions
    // var adjustedAst = astWithSource.ast.visit(this);
    var adjustedAst = source.ast;
    var fullName = isPresent(target) ? target + EVENT_TARGET_SEPARATOR + name : name;
    var result = new api.EventBinding(
        fullName, new ASTWithSource(adjustedAst, source.source, source.location));
    var event = new Event(name, target, fullName);
    if (isBlank(target)) {
      this.localEvents.push(event);
    } else {
      this.globalEvents.push(event);
    }
    return result;
  }

  visitAccessMember(ast: AccessMember): AccessMember {
    var isEventAccess = false;
    var current: AST = ast;
    while (!isEventAccess && (current instanceof AccessMember)) {
      var am = <AccessMember>current;
      if (am.name == '$event') {
        isEventAccess = true;
      }
      current = am.receiver;
    }

    if (isEventAccess) {
      this.locals.push(ast);
      var index = this.locals.length - 1;
      return new AccessMember(this._implicitReceiver, `${index}`, (arr) => arr[index], null);
    } else {
      return ast;
    }
  }

  buildEventLocals(): List<AST> { return this.locals; }

  buildLocalEvents(): List<Event> { return this.localEvents; }

  buildGlobalEvents(): List<Event> { return this.globalEvents; }

  merge(eventBuilder: EventBuilder) {
    this._merge(this.localEvents, eventBuilder.localEvents);
    this._merge(this.globalEvents, eventBuilder.globalEvents);
    ListWrapper.concat(this.locals, eventBuilder.locals);
  }

  _merge(host: List<Event>, tobeAdded: List<Event>) {
    var names = [];
    for (var i = 0; i < host.length; i++) {
      names.push(host[i].fullName);
    }
    for (var j = 0; j < tobeAdded.length; j++) {
      if (!ListWrapper.contains(names, tobeAdded[j].fullName)) {
        host.push(tobeAdded[j]);
      }
    }
  }
}

var PROPERTY_PARTS_SEPARATOR = new RegExp('\\.');
const ATTRIBUTE_PREFIX = 'attr';
const CLASS_PREFIX = 'class';
const STYLE_PREFIX = 'style';

function buildElementPropertyBindings(
    schemaRegistry: ElementSchemaRegistry, protoElement: /*element*/ any, isNgComponent: boolean,
    bindingsInTemplate: Map<string, ASTWithSource>, directiveTempaltePropertyNames: Set<string>):
    List<api.ElementPropertyBinding> {
  var propertyBindings = [];
  MapWrapper.forEach(bindingsInTemplate, (ast, propertyNameInTemplate) => {
    var propertyBinding = createElementPropertyBinding(schemaRegistry, ast, propertyNameInTemplate);
    if (isValidElementPropertyBinding(schemaRegistry, protoElement, isNgComponent,
                                      propertyBinding)) {
      propertyBindings.push(propertyBinding);
    } else if (!isPresent(directiveTempaltePropertyNames) ||
               !SetWrapper.has(directiveTempaltePropertyNames, propertyNameInTemplate)) {
      // directiveTempaltePropertyNames is null for host property bindings
      var exMsg =
          `Can't bind to '${propertyNameInTemplate}' since it isn't a known property of the '<${DOM.tagName(protoElement).toLowerCase()}>' element`;
      if (isPresent(directiveTempaltePropertyNames)) {
        exMsg += ' and there are no matching directives with a corresponding property';
      }
      throw new BaseException(exMsg);
    }
  });
  return propertyBindings;
}

function isValidElementPropertyBinding(schemaRegistry: ElementSchemaRegistry,
                                       protoElement: /*element*/ any, isNgComponent: boolean,
                                       binding: api.ElementPropertyBinding): boolean {
  if (binding.type === api.PropertyBindingType.PROPERTY) {
    if (!isNgComponent) {
      return schemaRegistry.hasProperty(protoElement, binding.property);
    } else {
      // TODO(pk): change this logic as soon as we can properly detect custom elements
      return DOM.hasProperty(protoElement, binding.property);
    }
  }
  return true;
}

function createElementPropertyBinding(schemaRegistry: ElementSchemaRegistry, ast: ASTWithSource,
                                      propertyNameInTemplate: string): api.ElementPropertyBinding {
  var parts = StringWrapper.split(propertyNameInTemplate, PROPERTY_PARTS_SEPARATOR);
  if (parts.length === 1) {
    var propName = schemaRegistry.getMappedPropName(parts[0]);
    return new api.ElementPropertyBinding(api.PropertyBindingType.PROPERTY, ast, propName);
  } else if (parts[0] == ATTRIBUTE_PREFIX) {
    return new api.ElementPropertyBinding(api.PropertyBindingType.ATTRIBUTE, ast, parts[1]);
  } else if (parts[0] == CLASS_PREFIX) {
    return new api.ElementPropertyBinding(api.PropertyBindingType.CLASS, ast,
                                          camelCaseToDashCase(parts[1]));
  } else if (parts[0] == STYLE_PREFIX) {
    var unit = parts.length > 2 ? parts[2] : null;
    return new api.ElementPropertyBinding(api.PropertyBindingType.STYLE, ast, parts[1], unit);
  } else {
    throw new BaseException(`Invalid property name ${propertyNameInTemplate}`);
  }
}

import 'isomorphic-fetch';
import {resolve} from "relative-to-absolute-iri";
import {FetchDocumentLoader} from "./FetchDocumentLoader";
import {IDocumentLoader} from "./IDocumentLoader";
import {IJsonLdContextNormalized, IPrefixValue, JsonLdContext} from "./JsonLdContext";

/**
 * Parses JSON-LD contexts.
 */
export class ContextParser implements IDocumentLoader {

  // Regex for valid IRIs
  public static readonly IRI_REGEX: RegExp = /^([A-Za-z][A-Za-z0-9+-.]*|_):/;

  // Keys in the contexts that will not be expanded based on the base IRI
  private static readonly EXPAND_KEYS_BLACKLIST: string[] = [
    '@base',
    '@vocab',
    '@language',
  ];
  // Keys in the contexts that may not be aliased
  private static readonly ALIAS_KEYS_BLACKLIST: string[] = [
    '@container',
    '@graph',
    '@id',
    '@index',
    '@list',
    '@nest',
    '@none',
    '@prefix',
    '@reverse',
    '@set',
    '@type',
    '@value',
  ];
  // All valid @container values
  private static readonly CONTAINERS: string[] = [
    '@list',
    '@set',
    '@index',
    '@language',
  ];

  private readonly documentLoader: IDocumentLoader;
  private readonly documentCache: {[url: string]: any};
  private readonly validate: boolean;
  private readonly expandContentTypeToBase: boolean;

  constructor(options?: IContextParserOptions) {
    options = options || {};
    this.documentLoader = options.documentLoader || new FetchDocumentLoader();
    this.documentCache = {};
    this.validate = !options.skipValidation;
    this.expandContentTypeToBase = options.expandContentTypeToBase;
  }

  /**
   * Get the prefix from the given term.
   * @see https://json-ld.org/spec/latest/json-ld/#compact-iris
   * @param {string} term A term that is an URL or a prefixed URL.
   * @param {IJsonLdContextNormalized} context A context.
   * @return {string} The prefix or null.
   */
  public static getPrefix(term: string, context: IJsonLdContextNormalized): string {
    const separatorPos: number = term.indexOf(':');
    if (separatorPos >= 0) {
      // Suffix can not begin with two slashes
      if (term.length > separatorPos + 1
        && term.charAt(separatorPos + 1) === '/'
        && term.charAt(separatorPos + 2) === '/') {
        return null;
      }

      const prefix: string = term.substr(0, separatorPos);

      // Prefix can not be an underscore (this is a blank node)
      if (prefix === '_') {
        return null;
      }

      // Prefix must match a term in the active context
      if (context[prefix]) {
        return prefix;
      }
    }
    return null;
  }

  /**
   * From a given context entry value, get the string value, or the @id field.
   * @param contextValue A value for a term in a context.
   * @return {string} The id value, or null.
   */
  public static getContextValueId(contextValue: any): string {
    if (contextValue === null || typeof contextValue === 'string') {
      return contextValue;
    }
    const id = contextValue['@id'];
    return id ? id : null;
  }

  /**
   * Expand the term or prefix of the given term if it has one,
   * otherwise return the term as-is.
   *
   * Iff in vocab-mode, then other references to other terms in the context can be used,
   * such as to `myTerm`:
   * ```
   * {
   *   "myTerm": "http://example.org/myLongTerm"
   * }
   * ```
   *
   * @param {string} term A term that is an URL or a prefixed URL.
   * @param {IJsonLdContextNormalized} context A context.
   * @param {boolean} vocab If the term is a predicate or type and should be expanded based on @vocab,
   *                        otherwise it is considered a regular term that is expanded based on @base.
   * @return {string} The expanded term, the term as-is, or null if it was explicitly disabled in the context.
   */
  public static expandTerm(term: string, context: IJsonLdContextNormalized, vocab?: boolean): string {
    const contextValue = context[term];

    // Immediately return if the term was disabled in the context
    if (contextValue === null || (contextValue && contextValue['@id'] === null)) {
      return null;
    }

    // Check the @id
    if (contextValue && vocab) {
      const value = this.getContextValueId(contextValue);
      if (value && value !== term) {
        return value;
      }
    }

    // Check if the term is prefixed
    const prefix: string = ContextParser.getPrefix(term, context);
    if (prefix) {
      const value = this.getContextValueId(context[prefix]);
      if (value) {
        return value + term.substr(prefix.length + 1);
      }
    } else if (vocab && context['@vocab'] && term.charAt(0) !== '@' && term.indexOf(':') < 0) {
      return context['@vocab'] + term;
    } else if (!vocab && context['@base'] && term.charAt(0) !== '@' && term.indexOf(':') < 0) {
      return resolve(term, context['@base']);
    }
    return term;
  }

  /**
   * Check if the given context value can be a prefix value.
   * @param value A context value.
   * @return {boolean} If it can be a prefix value.
   */
  public static isPrefixValue(value: any): boolean {
    return value && (typeof value === 'string' || value['@id'] || value['@type']);
  }

  /**
   * Check if the given IRI is valid.
   * @param {string} iri A potential IRI.
   * @return {boolean} If the given IRI is valid.
   */
  public static isValidIri(iri: string): boolean {
    return ContextParser.IRI_REGEX.test(iri);
  }

  /**
   * Add an @id term for all @reverse terms.
   * @param {IJsonLdContextNormalized} context A context.
   * @return {IJsonLdContextNormalized} The mutated input context.
   */
  public static idifyReverseTerms(context: IJsonLdContextNormalized): IJsonLdContextNormalized {
    for (const key of Object.keys(context)) {
      const value: IPrefixValue = context[key];
      if (value && typeof value === 'object') {
        if (value['@reverse'] && !value['@id']) {
          if (typeof value['@reverse'] !== 'string') {
            throw new Error(`Invalid @reverse value: '${value['@reverse']}'`);
          }
          value['@id'] = <string> value['@reverse'];
          value['@reverse'] = <any> true;
        }
      }
    }

    return context;
  }

  /**
   * Expand all prefixed terms in the given context.
   * @param {IJsonLdContextNormalized} context A context.
   * @param {boolean} expandContentTypeToBase If @type inside the context may be expanded
   *                                          via @base if @vocab is set to null.
   * @return {IJsonLdContextNormalized} The mutated input context.
   */
  public static expandPrefixedTerms(context: IJsonLdContextNormalized,
                                    expandContentTypeToBase: boolean): IJsonLdContextNormalized {
    for (const key of Object.keys(context)) {
      // Only expand allowed keys
      if (ContextParser.EXPAND_KEYS_BLACKLIST.indexOf(key) < 0) {
        // Error if we try to alias a keyword to something else.
        if (key[0] === '@' && ContextParser.ALIAS_KEYS_BLACKLIST.indexOf(key) >= 0) {
          throw new Error(`Keywords can not be aliased to something else.
Tried mapping ${key} to ${context[key]}`);
        }

        // Loop because prefixes might be nested
        while (ContextParser.isPrefixValue(context[key])) {
          const value: IPrefixValue = context[key];
          let changed: boolean = false;
          if (typeof value === 'string') {
            context[key] = ContextParser.expandTerm(value, context, true);
            changed = changed || value !== context[key];
          } else {
            const id = value['@id'];
            const type = value['@type'];
            if (id) {
              context[key]['@id'] = ContextParser.expandTerm(id, context, true);
              changed = changed || id !== context[key]['@id'];
            }
            if (type && type !== '@vocab') {
              // First check @vocab, then fallback to @base
              context[key]['@type'] = ContextParser.expandTerm(type, context, true);
              if (expandContentTypeToBase && type === context[key]['@type']) {
                context[key]['@type'] = ContextParser.expandTerm(type, context, false);
              }
              changed = changed || type !== context[key]['@type'];
            }
          }
          if (!changed) {
            break;
          }
        }
      }
    }

    return context;
  }

  /**
   * Validate the entries of the given context.
   * @param {IJsonLdContextNormalized} context A context.
   */
  public static validate(context: IJsonLdContextNormalized) {
    for (const key of Object.keys(context)) {
      const value = context[key];
      const valueType = typeof value;
      // First check if the key is a keyword
      if (key[0] === '@') {
        switch (key.substr(1)) {
        case 'vocab':
          if (value !== null && valueType !== 'string') {
            throw new Error(`Found an invalid @vocab IRI: ${value}`);
          }
          break;
        case 'base':
          if (value !== null && valueType !== 'string') {
            throw new Error(`Found an invalid @base IRI: ${context[key]}`);
          }
          break;
        case 'language':
          if (value !== null && valueType !== 'string') {
            throw new Error(`Found an invalid @language string: ${value}`);
          }
          break;
        }
      }

      // Otherwise, consider the key a term
      if (value !== null) {
        switch (valueType) {
        case 'string':
          // Always valid
          break;
        case 'object':
          if (key.indexOf(':') < 0 && !('@id' in value)
            && (value['@type'] === '@id' ? !context['@base'] : !context['@vocab'])) {
            throw new Error(`Missing @id in context entry: '${key}': '${JSON.stringify(value)}'`);
          }

          for (const objectKey of Object.keys(value)) {
            const objectValue = value[objectKey];
            if (!objectValue) {
              continue;
            }

            switch (objectKey) {
            case '@id':
              if (objectValue[0] === '@' && objectValue !== '@type' && objectValue !== '@id') {
                throw new Error(`Illegal keyword alias in term value, found: '${key}': '${JSON.stringify(value)}'`);
              }
              break;
            case '@type':
              if (objectValue !== '@id' && objectValue !== '@vocab'
                && (objectValue[0] === '_' || !ContextParser.isValidIri(objectValue))) {
                throw new Error(`A context @type must be an absolute IRI, found: '${key}': '${objectValue}'`);
              }
              break;
            case '@reverse':
              if (typeof objectValue === 'string' && value['@id'] && value['@id'] !== objectValue) {
                throw new Error(`Found non-matching @id and @reverse term values in '${key}':\
'${objectValue}' and '${value['@id']}'`);
              }
              break;
            case '@container':
              if (objectValue === '@list' && value['@reverse']) {
                throw new Error(`Term value can not be @container: @list and @reverse at the same time on '${key}'`);
              }
              if (ContextParser.CONTAINERS.indexOf(objectValue) < 0) {
                throw new Error(`Invalid term @container for '${key}' ('${objectValue}'), \
must be one of ${ContextParser.CONTAINERS.join(', ')}`);
              }
              break;
            case '@language':
              if (objectValue !== null && typeof objectValue !== 'string') {
                throw new Error(`Found an invalid term @language string in: '${key}': '${JSON.stringify(value)}'`);
              }
              break;
            }
          }
          break;
        default:
          throw new Error(`Found an invalid term value: '${key}': '${value}'`);
        }
      }
    }
  }

  /**
   * Parse a JSON-LD context in any form.
   * @param {JsonLdContext} context A context, URL to a context, or an array of contexts/URLs.
   * @param {IParseOptions} options Optional parsing options.
   * @return {Promise<IJsonLdContextNormalized>} A promise resolving to the context.
   */
  public async parse(context: JsonLdContext,
                     { baseIri, parentContext, external }: IParseOptions = {}): Promise<IJsonLdContextNormalized> {
    if (context === null || context === undefined) {
      // Context that are explicitly set to null are empty.
      return baseIri ? { '@base': baseIri } : {};
    } else if (typeof context === 'string') {
      return this.parse(await this.load(context), { baseIri, parentContext, external: true });
    } else if (Array.isArray(context)) {
      // As a performance consideration, first load all external contexts in parallel.
      const contexts = await Promise.all(context.map((subContext) => {
        if (typeof subContext === 'string') {
          return this.load(subContext);
        } else {
          return subContext;
        }
      }));

      return contexts.reduce((accContextPromise, contextEntry) => accContextPromise
        .then((accContext) => this.parse(contextEntry, { baseIri, parentContext: accContext, external })),
        Promise.resolve(parentContext));
    } else if (typeof context === 'object') {
      // We have an actual context object.
      let newContext: any = {};

      // According to the JSON-LD spec, @base must be ignored from external contexts.
      if (external) {
        delete context['@base'];
      }

      // Override the base IRI if provided.
      if (baseIri && !('@base' in newContext)) {
        newContext['@base'] = baseIri;
      }

      newContext = { ...newContext, ...parentContext, ...context };
      ContextParser.idifyReverseTerms(newContext);
      ContextParser.expandPrefixedTerms(newContext, this.expandContentTypeToBase);
      if (this.validate) {
        ContextParser.validate(newContext);
      }
      return newContext;
    } else {
      throw new Error(`Tried parsing a context that is not a string, array or object, but got ${context}`);
    }
  }

  public async load(url: string): Promise<IJsonLdContextNormalized> {
    const cached = this.documentCache[url];
    if (cached) {
      return Array.isArray(cached) ? cached.slice() : {... cached};
    }
    return this.documentCache[url] = (await this.documentLoader.load(url))['@context'];
  }

}

export interface IContextParserOptions {
  /**
   * An optional loader that should be used for fetching external JSON-LD contexts.
   */
  documentLoader?: IDocumentLoader;
  /**
   * By default, JSON-LD contexts will be validated.
   * This can be disabled by setting this option to true.
   * This will achieve slightly better performance for large contexts,
   * and may be useful if contexts are known to be valid.
   */
  skipValidation?: boolean;
  /**
   * If @type inside the context may be expanded via @base is @vocab is set to null.
   */
  expandContentTypeToBase?: boolean;
}

export interface IParseOptions {
  /**
   * An optional fallback base IRI to set.
   */
  baseIri?: string;
  /**
   * The parent context.
   */
  parentContext?: IJsonLdContextNormalized;
  /**
   * If the parsing context is an external context.
   */
  external?: boolean;
}

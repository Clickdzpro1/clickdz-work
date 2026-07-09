/**
 * CDZ Chat — Lit → React bridge.
 *
 * The existing AFFiNE AI chat UI is built from Lit web components
 * (`ShadowlessElement` subclasses in `blocksuite/ai/components/`). The new CDZ
 * chat inputs are React components. Rather than rewrite the entire Lit chat
 * stack (high risk, high effort), this bridge mounts a React component inside
 * a Lit element via `createRoot`, with proper lifecycle wiring.
 *
 * Usage — create a Lit custom element that hosts a React component:
 *
 *   const HostCtor = await createReactBridge<CdzChatInputProps>(
 *     'cdz-chat-input-host',
 *     (props, container) => <ClaudeChatInput {...props} />
 *   );
 *   customElements.define('cdz-chat-input-host', HostCtor);
 *
 * Then in any Lit template: `<cdz-chat-input-host .props=${props}></cdz-chat-input-host>`
 *
 * The bridge handles:
 *   - createRoot on connectedCallback (element is in the DOM)
 *   - re-render on `updated()` (props change)
 *   - unmount on disconnectedCallback (element removed)
 *   - ShadowlessElement base (no Shadow DOM, so global Tailwind + the scoped
 *     `.cdz-chat-scope` styles apply — same pattern the existing ai-chat-input
 *     uses via ShadowlessElement)
 *
 * ESM note: Lit + @blocksuite/block-std are imported with dynamic `import()` so
 * this module is safe to load from the ESM-first @affine/core package (no
 * top-level `require()`). The bridge class is created lazily via async.
 */
import type { Root } from 'react-dom/client';
import type { ReactNode } from 'react';

// Lazy module caches so we never do the dynamic import more than once.
type ShadowlessElementType = {
  new (): HTMLElement & {
    updated(): void;
    connectedCallback(): void;
    disconnectedCallback(): void;
  };
};
let ShadowlessElementCtor: ShadowlessElementType | null = null;
let propertyDecorator: (opts: {
  attribute: boolean;
}) => PropertyDecorator | null = null;

async function loadLitBase() {
  if (!ShadowlessElementCtor) {
    const mod = await import('@blocksuite/block-std');
    ShadowlessElementCtor = mod.ShadowlessElement as unknown as ShadowlessElementType;
  }
  if (!propertyDecorator) {
    const lit = await import('lit');
    propertyDecorator = lit.property as unknown as typeof propertyDecorator;
  }
  return { ShadowlessElement: ShadowlessElementCtor, property: propertyDecorator };
}

let createRootFn: typeof import('react-dom/client').createRoot | null = null;
async function getCreateRoot() {
  if (!createRootFn) {
    createRootFn = (await import('react-dom/client')).createRoot;
  }
  return createRootFn;
}

/**
 * Wrap a React render function in a Lit ShadowlessElement that hosts it.
 *
 * @param componentName  Custom element name (must contain a hyphen).
 * @param render         Function returning the React node, given props.
 * @returns              A Promise resolving to a Lit element class ready for
 *                       `customElements.define`.
 *
 * The class is returned asynchronously because Lit + react-dom/client are
 * loaded with dynamic imports. Callers should `await` this once at app init
 * (e.g. in a registry/effect module) and define the custom element.
 */
export async function createReactBridge<Props>(
  componentName: string,
  render: (props: Props, container: HTMLElement) => ReactNode
): Promise<new () => HTMLElement> {
  const { ShadowlessElement, property } = await loadLitBase();
  const propDecorator = property!;

  return class CDZReactBridge extends ShadowlessElement {
    private _root: Root | null = null;

    @propDecorator({ attribute: false })
    accessor props!: Props;

    static override get is() {
      return componentName;
    }

    override connectedCallback() {
      super.connectedCallback();
      void this._mount();
    }

    private async _mount() {
      const createRoot = await getCreateRoot();
      this._root = createRoot(this as unknown as HTMLElement);
      this._renderReact();
    }

    override updated() {
      this._renderReact();
    }

    private _renderReact() {
      if (this._root && this.props !== undefined) {
        this._root.render(render(this.props, this as unknown as HTMLElement));
      }
    }

    override disconnectedCallback() {
      super.disconnectedCallback();
      this._root?.unmount();
      this._root = null;
    }
  } as unknown as new () => HTMLElement;
}

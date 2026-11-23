// The editor library reads the page as it loads, and there is no page under node.
// Nothing in the tests opens an editor, so the names and their shapes are all that
// is needed.
export class WidgetType {}
export class EditorView {
	static decorations = { compute: (): unknown[] => [], from: (): unknown[] => [] };
}
export const Decoration = {
	none: {},
	mark: (): { range: () => object } => ({ range: () => ({}) }),
	widget: (): { range: () => object } => ({ range: () => ({}) }),
	set: (): object => ({}),
};

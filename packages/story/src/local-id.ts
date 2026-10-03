const UNSAFE_LOCAL_ID = /[\s<>:"/\\|?*]/u;

const SAFE_ID_START = String.raw`[^\s<>:"/\\|?*\u0000-\u001F\u007F.]`;
const SAFE_ID_CONTINUE = String.raw`[^\s<>:"/\\|?*\u0000-\u001F\u007F]`;

function idFragment(maxLength: number): string {
	return String.raw`(?!.*\.$)${SAFE_ID_START}${SAFE_ID_CONTINUE}{0,${maxLength - 1}}`;
}

export const LOCAL_ID_FRAGMENT = idFragment(127);
export const IDENTITY_ID_FRAGMENT = idFragment(299);
export const LOCAL_ID_PATTERN = `^${LOCAL_ID_FRAGMENT}$`;
export const IDENTITY_ID_PATTERN = `^${IDENTITY_ID_FRAGMENT}$`;

function isSafeId(value: string, maxLength: number): boolean {
	return (
		value.length > 0 &&
		value.length <= maxLength &&
		value === value.normalize("NFC") &&
		value[0] !== "." &&
		!value.endsWith(".") &&
		!UNSAFE_LOCAL_ID.test(value) &&
		![...value].some((character) => {
			const codePoint = character.codePointAt(0);
			return codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f);
		})
	);
}

export function isLocalId(value: string): boolean {
	return isSafeId(value, 127);
}

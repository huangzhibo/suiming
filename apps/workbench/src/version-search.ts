/** 短数字按版本号查找；长到不可能是现有版本号时，仍允许纯数字的提交编号前缀。 */
export function rankVersion(id: string, label: string, query: string, total: number): number {
	const search = query.trim().toLowerCase();
	if (!search || search === label || search === label.slice(1) || search === id) return 1;
	if (label.startsWith(search) || label.slice(1).startsWith(search)) return 0.8;
	if (/^\d+$/u.test(search)) return search.length > String(total).length && id.startsWith(search) ? 0.6 : 0;
	if (id.startsWith(search)) return 0.6;
	return id.includes(search) ? 0.4 : 0;
}

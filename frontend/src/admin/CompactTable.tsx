import { ReactNode } from 'react';
export type Column<T>={key:string;title:string;numeric?:boolean;render:(row:T)=>ReactNode};
export default function CompactTable<T>({columns,rows,rowKey,empty='Нет данных'}:{columns:Column<T>[];rows:T[];rowKey:(row:T)=>string|number;empty?:string}){
  return <div className="admin-table-wrap"><table className="admin-table"><thead><tr>{columns.map(c=><th className={c.numeric?'numeric':''} key={c.key}>{c.title}</th>)}</tr></thead><tbody>{rows.length?rows.map(row=><tr key={rowKey(row)}>{columns.map(c=><td className={c.numeric?'numeric':''} key={c.key}>{c.render(row)}</td>)}</tr>):<tr><td className="admin-empty" colSpan={columns.length}>{empty}</td></tr>}</tbody></table></div>;
}

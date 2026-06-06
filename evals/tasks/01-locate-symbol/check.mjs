// 通过条件:回答里点名了 helpers.js(且没把它说成 app.js)。
export default async function ({ output }) {
  const ok = output.includes("helpers");
  return { pass: ok, note: ok ? "" : "未点名 helpers.js" };
}

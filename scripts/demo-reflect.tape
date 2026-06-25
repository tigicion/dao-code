# DAO 反思器记忆 demo:① 存储偏好 → ② 新会话召回(简洁) → ③ 无记忆对照(啰嗦)
# 跑:HOME 与 key 由外部隔离环境提供(见 scripts 注释);vhs scripts/demo-reflect.tape
Output docs/assets/demo-reflect.gif
Set Shell "zsh"
Set FontSize 15
Set Width 1240
Set Height 800
Set Theme "Dracula"
Set Padding 16
Set TypingSpeed 35ms

# ── 隔离环境(不录)──
Hide
Type 'setopt interactive_comments; export HOME=/tmp/dao-demo-home && cd /tmp/dao-demo && rm -rf .dao "$HOME/.dao" && clear'
Enter
Show

# ① 存储:告诉它一个偏好,反思器/主动路径落盘
Type "# ① 教它一个回答偏好(本会话存入跨会话记忆)"
Enter
Type "DAO_REFLECT_SYNC=1 dao"
Enter
Sleep 6s
Type "以后回答务必【极简】:先用 ✅ 加粗一句话结论,最多再补一两句,不要长篇大论。记住。"
Enter
Sleep 16s
Type "/exit"
Enter
Sleep 5s

# 证明它存下来了
Type "# 看一眼存下的记忆 ↓"
Enter
Type "cat ~/.dao/memory/*.md"
Enter
Sleep 5s

# ② 召回:全新会话,问一个 yes/no 式问题,它按偏好极简先给结论
Type "# ② 全新会话——它自动召回上面的偏好"
Enter
Type "dao"
Enter
Sleep 6s
Type "用 setTimeout 做搜索框防抖,可靠吗?"
Enter
Sleep 24s
Type "/exit"
Enter
Sleep 5s

# ③ 对照:同一问题,关掉记忆 → 回到啰嗦默认(无 ✅、长篇)
Type "# ③ DAO_NO_MEMORY=1 关掉记忆,同一个问题对照"
Enter
Type "DAO_NO_MEMORY=1 dao"
Enter
Sleep 6s
Type "用 setTimeout 做搜索框防抖,可靠吗?"
Enter
Sleep 42s
Type "/exit"
Enter
Sleep 4s

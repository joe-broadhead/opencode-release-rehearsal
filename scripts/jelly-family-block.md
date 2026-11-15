<!-- Jelly's shared sentences for every family plugin's docs/jelly.md, word for word: the text between the markers below
is jelly's guide, docs/guides/plugin-authors.md lines 701-714 at commit 875026118 (identical to rd912's comment
6866914058). Kit file, pinned by check-copies.mjs; check-drift.mjs requires docs/jelly.md to carry exactly this block.
Change it only when jelly's guide changes, in every plugin at once. -->
<!-- family-block:start -->
- At Allowed (`all`), the default, every tool runs without asking, declared or not, whatever its `effect`.
- At Ask before changes (`ask-changes`), a `readOnly` tool runs, and every other tool asks first, including a tool this plugin does not declare.
- At Read only (`read-only`), a `readOnly` tool runs, and every other tool is off, including a tool this plugin does not declare.
- A declared `effect` of `allow` changes nothing: the tool follows the access choice and its `readOnly`.
- A declared `effect` of `ask` makes the tool ask at Ask before changes, even when it is `readOnly`, and changes nothing at Allowed or Read only.
- A declared `effect` of `deny` turns the tool off at Ask before changes and at Read only, and changes nothing at Allowed.
- An action listed in `asks` asks first at Ask before changes and at Read only, and never at Allowed.
- A tool named with one `*`, such as another account's `plaud-*.get_file`, follows the same rules as a tool named in full.
- A choice the person makes for one tool wins over the access choice and the declared `effect`.
- jelly leaves out a key it does not know at the top level of the `jelly` block, and reads the rest.
- jelly refuses the plugin for a key it does not know inside anything it reads, such as a tool, a sign-in or a setting.
- jelly refuses the plugin, with one plain line, when `requires` names a field or a feature it does not read.
<!-- family-block:end -->

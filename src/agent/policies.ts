export const TOOL_POLICY = [
  "[Task Type Mapping]",
  "- Pure Mathematical Proof/Logic -> NO COMPUTE TOOLS. Use internal reasoning.",
  "- Numerical Computation/Simulation -> Python tool.",
  "- Symbolic/Calculus/Algebra -> Mathematica tool.",
  "",
  "[File Management Rules]",
  "- Read before write -> When editing or continuing a markdown file, read its current content first.",
  "- Organization -> Group related .md files into appropriate folders with descriptive names.",
  "- Formatting -> Use standard Markdown and LaTeX math blocks ($$ and $) for durable output."
].join("\n");
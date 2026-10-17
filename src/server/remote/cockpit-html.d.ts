declare module "*.html" {
  /** The file's text, inlined by esbuild's text loader. */
  const content: string
  export default content
}

// Checks a value against the JSON Schema keywords the RPC contract uses: type (integer, and a list of types, included), enum, properties,
// required, additionalProperties: false and items. Returns one line per problem, so an empty list means valid.
type Schema = {
  readonly type?: string | readonly string[]
  readonly enum?: readonly unknown[]
  readonly properties?: Readonly<Record<string, Schema>>
  readonly required?: readonly string[]
  readonly additionalProperties?: boolean
  readonly items?: Schema
}

const typeOf = (value: unknown) => (Array.isArray(value) ? "array" : value === null ? "null" : typeof value)

export function schemaErrors(schema: Schema, value: unknown, path = "$"): string[] {
  const types = schema.type === undefined ? undefined : [schema.type].flat()
  const typed = types?.some((type) => (type === "integer" ? Number.isInteger(value) : typeOf(value) === type))
  if (types !== undefined && !typed) return [`${path} is ${typeOf(value)}, not ${types.join(" or ")}`]
  if (schema.enum !== undefined && !schema.enum.includes(value)) return [`${path} is ${JSON.stringify(value)}, not one of ${JSON.stringify(schema.enum)}`]
  if (Array.isArray(value) && schema.items) return value.flatMap((item, index) => schemaErrors(schema.items!, item, `${path}[${index}]`))
  if (typeOf(value) !== "object") return []
  const record = value as Record<string, unknown>
  const properties = schema.properties ?? {}
  return [
    ...(schema.required ?? []).filter((key) => !(key in record)).map((key) => `${path}.${key} is missing`),
    ...Object.entries(record).flatMap(([key, item]) => {
      const property = properties[key]
      if (property) return schemaErrors(property, item, `${path}.${key}`)
      return schema.additionalProperties === false ? [`${path}.${key} is not allowed`] : []
    }),
  ]
}

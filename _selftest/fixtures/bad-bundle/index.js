/**
 * 自检脚本的**坏样例**（fixture）：故意写错 schema / render，用来证明检查器真能抓到问题。
 * 不要在 profile 里安装它。
 */
export const name = 'bad-fixture'
export const inject = ['tools']

export function apply(ctx) {
  ctx.effect(() =>
    ctx.tools.register({
      name: 'bad_tool',
      description: 'Deliberately broken tool for checker tests.',
      parameters: { type: 'object', properties: {} },
      output: {
        schema: {
          type: 'object',
          properties: {
            // enum 与 type 不符
            kind: { type: 'integer', enum: ['a', 'b'] },
            // array 缺 items
            list: { type: 'array' },
            // 未知关键字
            weird: { type: 'string', nonsense: true },
          },
          // required 里有一个不在 properties 的字段
          required: ['missingField'],
          additionalProperties: 'false',
        },
        render() {
          // 返回形状不合法：缺 text
          return [{ type: 'text' }]
        },
      },
      async execute() {
        return {}
      },
    }),
  )
}

// 组件里只用来生成局部 id，不需要 nanoid 的完整能力。
let counter = 0
export const nanoid = (size = 10): string => {
  counter += 1
  const random = Math.random().toString(36).slice(2, 2 + size)
  return (random + counter.toString(36)).slice(0, size)
}

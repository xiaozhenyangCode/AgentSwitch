const pad = (n: number) => String(n).padStart(2, '0')
const hoursMinutes = (date: Date) => `${pad(date.getHours())}:${pad(date.getMinutes())}`
const monthDay = (date: Date) => `${pad(date.getMonth() + 1)}-${pad(date.getDate())}`

function formatYear(year: number): string {
  return `${year < 0 ? '-' : ''}${String(Math.abs(year)).padStart(4, '0')}`
}

function sameLocalDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
}

export function formatListTime(ts: number, now: Date, yesterday: (hm: string) => string): string {
  const date = new Date(ts)
  if (Number.isNaN(date.getTime())) return ''

  const hm = hoursMinutes(date)
  if (sameLocalDay(date, now)) return hm

  const previousDay = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1)
  if (sameLocalDay(date, previousDay)) return yesterday(hm)

  const year = date.getFullYear()
  const md = monthDay(date)
  if (year === now.getFullYear() && md < monthDay(now)) return `${md} ${hm}`
  return `${formatYear(year)}-${md} ${hm}`
}

export function formatFullLocalTime(ts: number): string {
  const date = new Date(ts)
  if (Number.isNaN(date.getTime())) return ''

  return `${formatYear(date.getFullYear())}-${monthDay(date)} ${hoursMinutes(date)}:${pad(date.getSeconds())}`
}

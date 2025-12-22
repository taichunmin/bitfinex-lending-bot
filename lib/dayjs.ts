import customParseFormat from 'dayjs/plugin/customParseFormat.js'
import dayjs from 'dayjs'
import utc from 'dayjs/plugin/utc.js'

dayjs.extend(customParseFormat)
dayjs.extend(utc)

export { dayjs }

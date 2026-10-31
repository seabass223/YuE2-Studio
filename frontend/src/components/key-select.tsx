import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectSeparator, SelectTrigger, SelectValue } from "@/components/ui/select"
import { KEY_HINT, MAJOR_KEYS, MINOR_KEYS } from "@/lib/api"

/** Musical key picker: Auto (YuE2 picks) or a major/minor key. */
export function KeySelect({
  id,
  value,
  onChange,
  disabled,
  title,
}: {
  id: string
  value: string | null
  onChange: (key: string | null) => void
  disabled?: boolean
  title?: string
}) {
  return (
    <Select value={value ?? "auto"} onValueChange={(key) => onChange(key === "auto" ? null : key)} disabled={disabled}>
      <SelectTrigger id={id} className="w-full" title={title ?? KEY_HINT}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="auto">Auto</SelectItem>
        <SelectSeparator />
        <SelectGroup>
          <SelectLabel>Major</SelectLabel>
          {MAJOR_KEYS.map((key) => (
            <SelectItem key={key} value={key}>
              {key}
            </SelectItem>
          ))}
        </SelectGroup>
        <SelectSeparator />
        <SelectGroup>
          <SelectLabel>Minor</SelectLabel>
          {MINOR_KEYS.map((key) => (
            <SelectItem key={key} value={key}>
              {key}
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  )
}

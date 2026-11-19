# roombook

命令行会议室预订工具。数据放在 `data/` 目录的三个 JSON 文件里。

## 用法

```
python3 -m roombook rooms
python3 -m roombook check ROOM DATE START END
python3 -m roombook book ROOM DATE START END --title TITLE
python3 -m roombook cancel BOOKING_ID
```

- `DATE` 写成 `YYYY-MM-DD`，`START` 和 `END` 是 24 小时制的 `HH:MM`。
- `--data DIR` 指定数据目录，默认是当前目录下的 `data/`。
- `check` 只查询、不写入；`book` 成功后把预订写进 `bookings.json`。
- 订不了的时候两个命令都输出 `error: ... is not available ...`，退出码是 1。

## 规则

- 预订要落在会议室的开放时间之内（`rooms.json` 里的 `opens` 到 `closes`）。
- 单次预订不能超过会议室的 `max_minutes`。
- 时间段按左闭右开算：09:00-10:00 的会和 10:00-11:00 的会不冲突。
- 周期预订写在 `series.json` 里。`weekdays` 用 ISO 编号（1 = 周一 … 7 = 周日），
  从 `from` 到 `until`（两端都算）之间，每周的这些天各占一次；`skip` 里的日期不占。

## 测试

```
python3 -m unittest discover -s tests
```

# rollcall

把会员名单（CSV）导进系统之前做的格式检查和整理。

```
node bin/import.mjs data/members.csv
node bin/import.mjs data/members.csv --out cleaned.csv
node bin/import.mjs some.csv --schema other-schema.json
```

- 每一列按 `data/schema.json` 里登记的字段类型检查；`required` 的列不能为空，其余的列空着就跳过。
- 有任何一格不合格，这一行就被拒掉，并且每个不合格的格子各报一行：
  `row 5, column email: "..." is not a valid email (like name@example.org)`。
  `row` 从 1 开始数，不算表头。
- 最后一行是汇总：`12 rows read, 10 accepted, 2 rejected`。有行被拒时退出码是 1。
- `--out` 把通过的行写成新的 CSV，其中的值已经整理成入库的写法（比如邮箱转小写、电话去掉分隔符）。

## 字段类型

每种字段类型是 `src/fields/` 下的一个模块，导出：

- `name`：类型名，也就是 schema 里写的那个；
- `hint`：报错时给出的示例；
- `isValid(value)`：这个值合不合格；
- `normalize(value)`（可选）：合格的值整理成入库的写法。

新加类型时照着现有模块写一个，再到 `src/fields/index.mjs` 登记。

## 测试

```
node --test
```

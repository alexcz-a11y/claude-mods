# nightly

每天夜里跑一遍的经营报表。每个报表是 `nightly/reports/` 下的一个模块，导出
`build(backend, day)`，返回一个可以直接写成 JSON 的列表；`day` 是 `YYYY-MM-DD`。

```
python3 -m nightly 2031-03-04                 # 跑全部报表，结果写到 out/<报表名>.json
python3 -m nightly 2031-03-04 --only top_products
python3 -m nightly 2031-03-04 --db fixtures/db.json --out out
```

跑完会打印一行汇总，其中 `backend calls` 是这次运行对平台数据服务的调用总数。

## 数据服务（`nightly/backend.py`）

`backend.py` 是平台组维护的客户端，和他们的仓库保持同步，**不要在这里改它**。本地开发时它读
`fixtures/db.json` 来模拟线上服务。接口只有三个，每调一次都算一次对服务的调用：

- `scan(table, day)`：取一张事实表（`orders`、`order_items`、`returns`、`shipments`、`tickets`）某一天的全部行。
- `get(table, id)`：按主键取一行，没有就返回 `None`。
- `get_many(table, ids)`：按主键取一批，返回 `{id: 行}`，不存在的 id 不出现在结果里。

维表（`customers`、`products`、`stores`、`regions`、`staff`、`suppliers`、`categories`、`carriers`）
不能整表扫描，只能按主键取。

## 加一个报表

在 `nightly/reports/` 里新建模块，写好 `build(backend, day)`，再到 `nightly/reports/__init__.py`
的 `REPORTS` 里登记。排序要写全（并列时有第二排序键），保证同样的数据每次输出都一样。

## 测试

```
python3 -m unittest discover -s tests
```

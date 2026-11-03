/** Built-in vulnerability audit prompts. Each one is scoped to a single class. */
export const BUILTIN_PROMPTS = [
  {
    name: 'SQL 注入',
    category: '注入',
    default_severity: 'critical',
    content: `审计目标：找出所有可被外部输入影响并进入 SQL 语句执行的路径。
检查清单：
1. 拼接字符串构造 SQL 的位置（字符串模板、+ 拼接、StringBuilder、动态表名/列名）。
2. ORM / MyBatis / JPA 中使用 \${...}、字符串拼接、原生查询的参数拼接。
3. 存储过程、动态 ORDER BY、LIMIT、LIKE、IN 子句等无法参数化的位置是否做了白名单校验。
4. 输入是否来自 HTTP 参数、Header、Cookie、消息队列、文件、数据库等不可信来源。
5. 二次注入：写入数据库后又拼接回 SQL 的数据。
判定标准：不可信输入未经过参数化绑定或严格白名单就进入 SQL 语法位置，才判定为漏洞。
误报排除：仅使用预编译参数、或拼接值来自常量/可信枚举。
严重级别：可直接读取或写入任意数据为 critical；仅影响查询条件为 high；受限场景为 medium。`,
  },
  {
    name: '跨站脚本 XSS',
    category: '注入',
    default_severity: 'high',
    content: `审计目标：找出不可信输入未经过编码就进入 HTML / DOM / JavaScript 上下文的路径。
检查清单：
1. 服务端模板：未转义输出（innerHTML、document.write、dangerouslySetInnerHTML、v-html、th:utext 等）。
2. 前端富文本渲染、Markdown 渲染是否关闭了 HTML 过滤。
3. URL / href / src / style / event handler 等属性上下文是否做了对应编码与协议校验（javascript:）。
4. 反射型、存储型、DOM 型（location.hash、document.referrer、postMessage）三条路径都要覆盖。
5. CSP 与 HttpOnly 只能降低影响，不能替代输出编码。
判定标准：不可信数据进入可执行上下文且没有上下文相关的编码/净化。
误报排除：使用了成熟净化库（如 DOMPurify）且配置正确，或输出经过严格白名单。
严重级别：存储型且影响已登录用户为 high/critical；反射型为 medium/high；纯 DOM 型为 medium。`,
  },
  {
    name: '命令注入与代码执行',
    category: '注入',
    default_severity: 'critical',
    content: `审计目标：找出不可信输入进入系统命令、Shell、进程参数或动态代码执行的位置。
检查清单：
1. Runtime.exec / ProcessBuilder / subprocess / os.system / exec / system() / popen 的调用。
2. 命令字符串拼接、shell=True、未转义参数、PowerShell 脚本拼接。
3. eval / Function / execScript / 反序列化表达式 / 模板引擎执行任意表达式。
4. 文件路径、URL、压缩包、日志内容等间接进入命令的路径。
5. 检查是否存在参数白名单、命令固定、输入转义或最小权限隔离。
判定标准：不可信输入能改变命令结构或执行任意代码。
误报排除：exec 接收固定命令且参数以数组传递并经过校验。
严重级别：可执行任意命令或代码为 critical。`,
  },
  {
    name: '路径穿越与任意文件读写',
    category: '文件',
    default_severity: 'high',
    content: `审计目标：找出不可信输入可控制文件路径并突破预期目录的位置。
检查清单：
1. 文件下载、上传、读取、删除、解压接口中的路径参数。
2. 是否仅使用字符串 replace("../")，是否处理 ..\\、URL 编码、绝对路径、软链接、Windows 短文件名。
3. 规范化后是否校验了 realpath 与允许根目录的前缀关系。
4. 压缩包解压（Zip Slip）是否校验每个条目路径。
5. 临时文件、日志文件、配置文件写入路径是否可被控制。
判定标准：可以读取或写入预期目录之外的文件。
误报排除：路径来自服务端常量，或规范化后严格限制在允许目录内。
严重级别：任意文件读写为 high/critical；仅可列举目录为 medium。`,
  },
  {
    name: '不安全的反序列化',
    category: '反序列化',
    default_severity: 'critical',
    content: `审计目标：找出不可信数据进入反序列化或对象绑定过程的位置。
检查清单：
1. Java ObjectInputStream、readObject、XStream、Fastjson autoType、Jackson 多态类型、Hessian、Kryo。
2. .NET BinaryFormatter / TypeNameHandling，PHP unserialize，Python pickle / yaml.load。
3. 反序列化前的类型白名单、类加载器限制、签名校验是否存在。
4. 序列化数据是否可被外部请求、Cookie、缓存、MQ 消息控制。
判定标准：不可信输入进入可触发任意类型构造或代码执行的反序列化入口。
误报排除：使用安全格式（JSON 且关闭多态）、或配置了严格类型白名单。
严重级别：可 RCE 为 critical。`,
  },
  {
    name: '认证与会话缺陷',
    category: '认证',
    default_severity: 'high',
    content: `审计目标：找出认证绕过、会话固定、弱令牌与权限提升问题。
检查清单：
1. 登录、注册、找回密码、验证码校验、OAuth / SSO 回调的完整流程。
2. 会话令牌生成是否使用安全随机数，是否可预测、是否在 URL 中传递、是否缺少轮换。
3. JWT：算法混淆（none/HS256 与公钥混用）、签名校验缺失、过期时间与吊销机制。
4. 越权：接口是否只校验登录而不校验对象归属（IDOR）、管理接口是否可达。
5. 密码重置令牌是否一次性、是否有有效期、是否绑定用户。
判定标准：可以不经过预期认证流程获得身份或更高权限。
误报排除：存在统一鉴权中间件且对象归属被显式校验。
严重级别：认证绕过或管理员越权为 critical；普通水平越权为 high；会话加固缺失为 medium。`,
  },
  {
    name: '服务端请求伪造 SSRF',
    category: '网络',
    default_severity: 'high',
    content: `审计目标：找出服务端使用不可信地址发起请求的位置。
检查清单：
1. Webhook、图片抓取、URL 预览、文件导入、代理、远程配置拉取。
2. 协议限制：是否允许 file://、gopher://、dict://、ftp://。
3. 内网地址校验：127.0.0.0/8、10/8、172.16/12、192.168/16、169.254/16、::1、元数据地址 169.254.169.254。
4. 重定向跟随、DNS 重绑定、IPv6 与十进制/八进制 IP 绕过。
5. 出网权限与响应内容回显程度。
判定标准：不可信输入可控制请求目标地址。
误报排除：目标域名白名单固定且禁用了重定向。
严重级别：可访问云元数据或内网服务为 high/critical；仅可探测外网为 medium。`,
  },
  {
    name: '硬编码凭据与敏感信息泄露',
    category: '配置',
    default_severity: 'high',
    content: `审计目标：找出代码、配置、日志中泄露的密钥与敏感数据。
检查清单：
1. 硬编码的数据库密码、API Key、AK/SK、JWT 签名密钥、私钥、证书口令。
2. 默认账号密码、调试开关、Swagger / Actuator / 管理后台未授权暴露。
3. 日志或异常响应中打印令牌、身份证、手机号、完整请求体。
4. .env、配置文件、CI 配置中的明文密钥，以及提交历史中的泄露。
5. 加密密钥与数据存放在同一位置，或使用弱随机数生成密钥。
判定标准：凭据或敏感信息以明文形式存在于可读取的代码/配置/日志中并可被利用。
误报排除：明确的示例值、测试用假密钥、已吊销的空值。
严重级别：生产可用凭据为 critical/high；调试信息泄露为 medium。`,
  },
  {
    name: '加密与随机数缺陷',
    category: '加密',
    default_severity: 'medium',
    content: `审计目标：找出错误的密码学用法。
检查清单：
1. 已淘汰算法：MD5、SHA1、DES、3DES、RC4、ECB 模式、无 IV 的 CBC。
2. 使用 Math.random / Random / rand() 生成令牌、验证码、密钥。
3. IV / Salt 固定或可预测，密钥派生未使用 PBKDF2/scrypt/Argon2。
4. 加密后未做完整性校验（无 MAC / AEAD），或自实现加密协议。
5. 证书校验被关闭（trustAll、verify=false、HostnameVerifier 返回 true）。
判定标准：加密原语或参数选择使机密性/完整性目标无法达成。
误报排除：仅用于非安全场景的校验和、或明确兼容旧数据的只读解密路径。
严重级别：签名密钥或会话令牌可预测为 high；弱哈希用于密码存储为 high；一般算法降级为 medium。`,
  },
  {
    name: '文件上传与 XXE',
    category: '文件',
    default_severity: 'high',
    content: `审计目标：找出文件上传校验缺失与 XML 外部实体注入。
检查清单：
1. 上传：扩展名、Content-Type、文件头魔数校验，是否可上传脚本/HTML/SVG，存储目录是否可执行。
2. 文件名是否可控制（路径穿越）、是否重命名、是否随机化。
3. 图片处理库是否可被恶意图片触发漏洞，压缩包是否限制大小与数量。
4. XML 解析器是否禁用 DOCTYPE、外部实体、外部 DTD（XXE），是否使用安全配置。
5. 上传后的文件访问是否带 Content-Disposition 与正确 Content-Type。
判定标准：可上传可执行/可解析文件并产生影响，或 XML 可读取本地文件/发起内网请求。
误报排除：上传文件存对象存储且强制下载，或 XML 解析器已禁用外部实体。
严重级别：上传 WebShell 或 XXE 读取敏感文件为 critical/high；受限上传为 medium。`,
  },
  {
    name: '竞态与业务逻辑',
    category: '业务逻辑',
    default_severity: 'medium',
    content: `审计目标：找出并发条件下的状态不一致与可绕过的业务约束。
检查清单：
1. 余额、库存、优惠券、积分、提现、下单等"检查—扣减"之间的时间窗口。
2. 幂等性缺失导致重复提交、重复领取、重复退款。
3. 数据库事务隔离级别、行锁/悲观锁/乐观锁、分布式锁是否正确使用。
4. 价格、数量、角色、状态等关键字段是否由客户端提交并可篡改。
5. 审批、支付回调、签名校验是否可伪造或重放。
判定标准：并发或重放能够获得超出业务规则的利益或破坏数据一致性。
误报排除：存在数据库唯一约束/原子更新/幂等键等可靠防护。
严重级别：直接资金损失为 critical/high；状态不一致为 medium。`,
  },
  {
    name: '依赖与供应链风险',
    category: '依赖',
    default_severity: 'medium',
    content: `审计目标：找出可被利用的第三方依赖与供应链问题。
检查清单：
1. 依赖清单中已知高危版本（反序列化、日志、模板、文件上传、鉴权组件）。
2. 依赖是否锁定版本、是否存在可被投毒的非官方源或私有仓库配置。
3. 构建脚本、postinstall、动态下载二进制的行为。
4. 反序列化/表达式/解析类库的默认配置是否安全。
5. 是否引入来源不明或长期未维护的组件。
判定标准：依赖的已知漏洞或配置可在本项目可达路径中被触发。
误报排除：漏洞代码路径不可达，或已有缓解措施。
严重级别：可达 RCE 为 critical/high；信息泄露为 medium；仅版本过旧为 low。`,
  },
  {
    name: '模板注入与表达式注入',
    category: '注入',
    default_severity: 'critical',
    content: `审计目标：找出不可信输入进入模板引擎、表达式引擎或 EL/SpEL/OGNL 求值的位置。
检查清单：
1. 服务端模板引擎（Jinja2、Twig、Freemarker、Velocity、Thymeleaf）是否使用动态模板内容或字符串拼接模板。
2. Spring EL、OGNL、MVEL、Groovy、JavaScript 引擎（Nashorn/GraalJS）的求值入口。
3. 用户输入进入模板变量时是否仍会被当作模板语法解析（二次渲染）。
4. 是否开启沙箱、是否限制了危险类与方法访问。
5. 前端模板编译（客户端模板）是否把用户输入当作模板源码。
判定标准：不可信输入能改变模板/表达式结构并被服务端执行。
误报排除：仅作为模板数据变量传入且引擎默认转义，或使用固定模板。
严重级别：可执行任意表达式或命令为 critical；仅可读取上下文变量为 medium/high。`,
  },
  {
    name: '日志、异常与信息泄露',
    category: '配置',
    default_severity: 'low',
    content: `审计目标：找出通过错误信息、日志、调试接口泄露的内部信息。
检查清单：
1. 异常堆栈直接返回给客户端、详细 SQL 错误、内网地址与框架版本。
2. 日志记录完整令牌、密码、Cookie、个人敏感信息。
3. 调试端点、健康检查、指标接口暴露内部状态且无鉴权。
4. 目录列表、备份文件、.git、.svn、编辑器临时文件可访问。
5. 响应头泄露服务器版本、缺少安全响应头。
判定标准：泄露的信息可辅助攻击者进一步利用系统。
误报排除：仅返回通用错误码，且日志已脱敏。
严重级别：可获取凭据或内网拓扑为 medium/high；一般信息泄露为 low。`,
  },
]

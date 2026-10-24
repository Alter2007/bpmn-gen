import org.flowable.engine.ProcessEngine;
import org.flowable.engine.ProcessEngineConfiguration;
import org.flowable.engine.ManagementService;
import org.flowable.engine.RepositoryService;
import org.flowable.engine.RuntimeService;
import org.flowable.engine.TaskService;
import org.flowable.engine.repository.Deployment;
import org.flowable.engine.repository.ProcessDefinition;
import org.flowable.engine.runtime.ProcessInstance;
import org.flowable.task.api.Task;

import java.io.File;
import java.io.FileInputStream;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * L4：真实部署 + 运行实例 + 路径断言。
 *
 * 做完了 L4-lite 之外最关键的一步：不是「引擎能解析」，而是「流程能真的跑完」。
 * 用 Flowable 官方的 standalone 内存引擎（H2 内存库），
 * 部署 -> 启动实例 -> 自动完成每个用户任务 -> 记录实际走过的节点 -> 断言到达结束。
 *
 * 用法：
 *   java -cp "<jar目录>\*" FlowableRun.java <file.bpmn|var=值,var2=值> [...]
 * 退出码：0 全部跑通 / 1 有失败 / 2 参数或环境问题
 */
public class FlowableRun {

    // 模板里 ${xxx} 引用的角色变量，缺失会抛表达式异常，这里给默认值
    private static final String[] ROLE_VARS = {
        "initiator", "manager", "director", "finance", "leader", "hr",
        "deptManager", "purchaseManager", "financeDirector", "legal",
        "business", "it", "admin", "sealKeeper", "approver"
    };

    public static void main(String[] args) {
        if (args.length == 0) {
            System.out.println("用法: java -cp \"<jar目录>\\*\" FlowableRun.java <file.bpmn|var=值> [...]");
            System.out.println("      java -cp \"<jar目录>\\*\" FlowableRun.java specs.txt   （每行一条规格）");
            System.out.println("示例: FlowableRun.java \"a.bpmn|amount=800\" \"a.bpmn|amount=6000\"");
            System.exit(2);
        }

        // 支持从文件读规格：分支覆盖会生成几十条，命令行走不下
        if (args.length == 1 && args[0].toLowerCase().endsWith(".txt")) {
            java.io.File specFile = new java.io.File(args[0]);
            if (!specFile.exists()) {
                System.out.println("[ERR] 规格文件不存在: " + args[0]);
                System.exit(2);
            }
            java.util.List<String> loaded = new java.util.ArrayList<String>();
            try {
                java.io.BufferedReader br = new java.io.BufferedReader(
                    new java.io.InputStreamReader(new java.io.FileInputStream(specFile), "UTF-8"));
                String line;
                while ((line = br.readLine()) != null) {
                    line = line.trim();
                    if (line.isEmpty() || line.startsWith("#")) continue;
                    loaded.add(line);
                }
                br.close();
            } catch (Exception e) {
                System.out.println("[ERR] 读取规格文件失败: " + e.getMessage());
                System.exit(2);
            }
            args = loaded.toArray(new String[0]);
            System.out.println("  从规格文件加载 " + args.length + " 条用例");
        }

        ProcessEngine engine;
        try {
            engine = ProcessEngineConfiguration
                .createStandaloneInMemProcessEngineConfiguration()
                .setJdbcUrl("jdbc:h2:mem:flowable-run;DB_CLOSE_DELAY=-1")
                .setDatabaseSchemaUpdate(ProcessEngineConfiguration.DB_SCHEMA_UPDATE_TRUE)
                .setAsyncExecutorActivate(false)
                .buildProcessEngine();
        } catch (Exception e) {
            System.out.println("[ERR] 引擎启动失败: " + e.getClass().getSimpleName() + ": " + e.getMessage());
            Throwable c = e.getCause();
            int guard = 0;
            while (c != null && guard++ < 5) {
                System.out.println("      由: " + c.getClass().getSimpleName() + ": " + c.getMessage());
                c = c.getCause();
            }
            System.exit(2);
            return;
        }

        RepositoryService repositoryService = engine.getRepositoryService();
        RuntimeService runtimeService = engine.getRuntimeService();
        TaskService taskService = engine.getTaskService();
        ManagementService managementService = engine.getManagementService();

        int ok = 0;
        int total = 0;
        Map<String, String> definitionByDeployment = new LinkedHashMap<String, String>();

        try {
            for (String spec : args) {
                total++;
                String[] parts = spec.split("\\|");
                String filePath = parts[0];
                Map<String, Object> vars = parseVars((parts.length > 1 && !parts[1].startsWith("expect")) ? parts[1] : "");

                File f = new File(filePath);
                if (!f.exists()) {
                    System.out.println("[FAIL] 文件不存在: " + filePath);
                    continue;
                }

                String label = f.getName() + "  " + describe(vars);
                String definitionId;
                try {
                    String cached = definitionByDeployment.get(filePath);
                    if (cached != null) {
                        definitionId = cached;
                    } else {
                        Deployment dep = repositoryService.createDeployment()
                            .name(f.getName())
                            .addInputStream(f.getName(), new FileInputStream(f))
                            .deploy();
                        ProcessDefinition pd = repositoryService.createProcessDefinitionQuery()
                            .deploymentId(dep.getId())
                            .singleResult();
                        if (pd == null) {
                            System.out.println("[FAIL] " + label + "  部署成功但查不到流程定义");
                            continue;
                        }
                        definitionId = pd.getId();
                        definitionByDeployment.put(filePath, definitionId);
                        System.out.println("  部署 OK: " + f.getName() + "  key=" + pd.getKey());

                        // 自动补齐 BPMN 里出现的处理人变量（flowable:assignee="${xxx}"），
                        // 否则新模板的 ${reviewer} ${gm} 之类会让引擎抛 Unknown property
                        try {
                            String xml = new String(java.nio.file.Files.readAllBytes(f.toPath()), "UTF-8");
                            java.util.regex.Matcher m = java.util.regex.Pattern
                                .compile("flowable:assignee=\"\\$\\{([^}]+)\\}\"").matcher(xml);
                            while (m.find()) {
                                String role = m.group(1).trim();
                                if (role.isEmpty()) continue;
                                if (!vars.containsKey(role)) {
                                    vars.put(role, "u_" + role);
                                }
                            }
                        } catch (Exception ignore) { /* 读不到就算了，主流程继续 */ }
                    }
                } catch (Exception e) {
                    System.out.println("[FAIL] " + label + "  部署失败: " + e.getClass().getSimpleName() + ": " + e.getMessage());
                    continue;
                }

                List<String> path = new ArrayList<String>();
                ProcessInstance pi;
                try {
                    injectRoles(f, vars);
                    pi = runtimeService.startProcessInstanceById(definitionId, vars);
                } catch (Exception e) {
                    System.out.println("[FAIL] " + label + "  启动实例失败: " + e.getClass().getSimpleName() + ": " + e.getMessage());
                    continue;
                }

                // 定时器断言：边界定时器是在"挂载的任务被激活"时才注册的，
                // 所以不能只在启动后查一次——全程跟踪出现过的最大定时器作业数。
                // 这也是"超时催办真的生效"的证据（光通过 XSD/解析不代表定时器被注册）。
                String expectTimer = timerOf(parts);
                String timerWhy = "";
                long maxTimerJobs = 0;

                // 前缀断言：驳回/退回会形成环，流程不会"结束"，
                // 只要路径前 k 段符合预期就停下并判定通过。
                String expectPrefix = prefixOf(parts);
                String expectC = containsOf(parts);
                boolean prefixDone = false;
                boolean containsDone = false;
                try {
                    // 一次完成一个任务、每次重新查询。
                    // 多实例（会签/或签）下：或签在第一个人签完后其余任务立即失效，
                    // 批量完成会撞上 "Cannot find task"，所以必须逐个来。
                    int guard = 0;
                    while (guard++ < 200) {
                        List<Task> tasks = taskService.createTaskQuery()
                            .processInstanceId(pi.getId())
                            .orderByTaskCreateTime().asc()
                            .list();
                        if (tasks.isEmpty()) break;
                        Task t = tasks.get(0);
                        path.add(stripTaskPrefix(t.getTaskDefinitionKey()) + "「" + safe(t.getName()) + "」");
                        taskService.complete(t.getId());
                        try {
                            long cnt = managementService.createTimerJobQuery()
                                .processInstanceId(pi.getId()).count();
                            if (cnt > maxTimerJobs) maxTimerJobs = cnt;
                        } catch (Exception ignore) { /* 老引擎没有定时器查询时忽略 */ }
                        String keys = joinKeys(path);
                        if (expectPrefix != null && keys.startsWith(expectPrefix)) {
                            prefixDone = true;
                            break;
                        }
                        // 驳回类断言：目标节点出现即算命中，不必等流程结束
                        // （驳回天然会回到前序节点，流程本来就不会自行结束）
                        if (expectC != null) {
                            boolean all = true;
                            for (String need : expectC.split(",")) {
                                String n = need.trim();
                                if (!n.isEmpty() && keys.indexOf(n) == -1) { all = false; break; }
                            }
                            if (all) { containsDone = true; break; }
                        }
                    }
                } catch (Exception e) {
                    System.out.println("[FAIL] " + label + "  执行中断: " + e.getClass().getSimpleName() + ": " + e.getMessage());
                    System.out.println("       已走: " + join(path));
                    continue;
                }

                boolean ended = runtimeService.createProcessInstanceQuery()
                    .processInstanceId(pi.getId()).count() == 0;

                // 路径断言：expect=A>B>C 精确；expectcontains=k1,k2 表示必须都出现（并行场景）；
                // expectprefix=A>B 表示前几段匹配即可（驳回环场景，流程不会结束）
                String expect = expectOf(parts);
                String expectContains = containsOf(parts);
                boolean assertOk = true;
                String why = "";

                if (expectPrefix != null) {
                    String actual = joinKeys(path);
                    if (!actual.startsWith(expectPrefix)) {
                        assertOk = false;
                        why = "期望路径以 " + expectPrefix + " 开头，实际 " + actual;
                    }
                } else if (expect != null) {
                    String actual = joinKeys(path);
                    if (!expect.equals(actual)) {
                        assertOk = false;
                        why = "期望路径 " + expect + "，实际 " + actual;
                    }
                }
                if (expectContains != null) {
                    for (String need : expectContains.split(",")) {
                        String n = need.trim();
                        if (n.isEmpty()) continue;
                        if (!joinKeys(path).contains(n)) {
                            assertOk = false;
                            why = why + " 缺少节点 " + n;
                        }
                    }
                }

                // 前缀断言不要求流程结束（驳回环本来就不会结束）
                if (expectTimer != null) {
                    try {
                        long want = Long.parseLong(expectTimer.trim());
                        if (maxTimerJobs != want) {
                            timerWhy = "期望出现过 " + want + " 个定时器作业，实际最多 " + maxTimerJobs;
                        }
                    } catch (Exception e) {
                        timerWhy = "定时器断言解析失败: " + e.getMessage();
                    }
                }
                if (!timerWhy.isEmpty()) { assertOk = false; why = (why.isEmpty() ? timerWhy : why + ' ' + timerWhy); }
                boolean settled = prefixDone || containsDone || ended;
                if (settled && !path.isEmpty() && assertOk) {
                    ok++;
                    System.out.println("[PASS] " + label);
                    System.out.println("       路径: " + join(path));
                } else {
                    System.out.println("[FAIL] " + label + "  ended=" + ended + "  路径: " + join(path));
                    if (!why.isEmpty()) System.out.println("       " + why);
                }
            }
        } finally {
            engine.close();
        }

        System.out.println("");
        System.out.println("实例运行通过 " + ok + " / " + total);
        System.exit(ok == total && total > 0 ? 0 : 1);
    }

    /** 把 BPMN 里出现的处理人变量（flowable:assignee="${x}"）补进变量表，缺什么补什么 */
    private static void injectRoles(File f, Map<String, Object> vars) {
        try {
            String xml = new String(java.nio.file.Files.readAllBytes(f.toPath()), "UTF-8");
            java.util.regex.Matcher m = java.util.regex.Pattern
                .compile("flowable:assignee=\"\\$\\{([^}]+)\\}\"").matcher(xml);
            while (m.find()) {
                String role = m.group(1).trim();
                if (role.isEmpty()) continue;
                if (!vars.containsKey(role)) vars.put(role, "u_" + role);
            }
        } catch (Exception ignore) { /* 读不到就算了 */ }
    }
    private static Map<String, Object> parseVars(String s) {
        Map<String, Object> vars = new HashMap<String, Object>();
        for (String r : ROLE_VARS) vars.put(r, "u_" + r);
        vars.put("amount", Integer.valueOf(0));
        vars.put("days", Integer.valueOf(0));
        if (s == null) return vars;
        for (String pair : s.split(",")) {
            if (pair.trim().isEmpty()) continue;
            String[] kv = pair.split("=", 2);
            if (kv.length != 2) continue;
            String k = kv[0].trim();
            String v = kv[1].trim();
            try {
                if (v.matches("-?\\d+")) vars.put(k, Integer.valueOf(v));
                // 列表：approvers=u1+u2+u3 代表三人会签。人数由列表长度决定，不写死在流程里。
                else if (v.indexOf('+') > 0) {
                    java.util.List<String> list = new java.util.ArrayList<String>();
                    for (String item : v.split("\\+")) {
                        if (!item.trim().isEmpty()) list.add(item.trim());
                    }
                    vars.put(k, list);
                }
                else if (v.matches("-?\\d+\\.\\d+")) vars.put(k, Double.valueOf(v));
                // 布尔字面量要转成 Boolean，否则条件表达式 ${x == false} 永远不成立
                else if (v.equalsIgnoreCase("true") || v.equalsIgnoreCase("false")) vars.put(k, Boolean.valueOf(v));
                else vars.put(k, v);
            } catch (NumberFormatException e) {
                vars.put(k, v);
            }
        }
        return vars;
    }

    private static String describe(Map<String, Object> vars) {
        Object amount = vars.get("amount");
        Object days = vars.get("days");
        StringBuilder sb = new StringBuilder();
        if (amount != null) sb.append("amount=").append(amount);
        if (days != null && !Integer.valueOf(0).equals(days)) {
            if (sb.length() > 0) sb.append(" ");
            sb.append("days=").append(days);
        }
        return sb.length() == 0 ? "" : "(" + sb + ")";
    }

    private static String stripTaskPrefix(String key) {
        return key == null ? "?" : key;
    }

    /** spec 形如 file|vars|expect=A>B；取出 expect 值 */
    private static String expectOf(String[] parts) {
        for (int i = 1; i < parts.length; i++) {
            if (parts[i].startsWith("expect=")) return parts[i].substring("expect=".length());
        }
        return null;
    }

    /** spec 形如 file|vars|expectcontains=k1,k2 */
    private static String containsOf(String[] parts) {
        for (int i = 1; i < parts.length; i++) {
            if (parts[i].startsWith("expectcontains=")) return parts[i].substring("expectcontains=".length());
        }
        return null;
    }

    /** spec 形如 file|vars|expectprefix=A>B —— 只要求路径以此开头（驳回环场景） */
    /** spec 形如 file|vars|expecttimer=1 —— 断言实例启动后注册了几个定时器作业 */
    private static String timerOf(String[] parts) {
        for (int i = 1; i < parts.length; i++) {
            if (parts[i].startsWith("expecttimer=")) return parts[i].substring("expecttimer=".length());
        }
        return null;
    }
    private static String prefixOf(String[] parts) {
        for (int i = 1; i < parts.length; i++) {
            if (parts[i].startsWith("expectprefix=")) return parts[i].substring("expectprefix=".length());
        }
        return null;
    }

    /** 只取节点 id（去掉「名称」部分）用于精确比较 */
    private static String joinKeys(List<String> list) {
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < list.size(); i++) {
            if (i > 0) sb.append(">");
            String s = list.get(i);
            int cut = s.indexOf('「');
            sb.append(cut > 0 ? s.substring(0, cut) : s);
        }
        return sb.toString();
    }

    private static String safe(String s) {
        return s == null ? "" : s;
    }

    private static String join(List<String> list) {
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < list.size(); i++) {
            if (i > 0) sb.append(" -> ");
            sb.append(list.get(i));
        }
        return sb.toString();
    }
}

import org.flowable.engine.ProcessEngine;
import org.flowable.engine.ProcessEngineConfiguration;
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
            System.out.println("示例: FlowableRun.java \"a.bpmn|amount=800\" \"a.bpmn|amount=6000\"");
            System.exit(2);
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

        int ok = 0;
        int total = 0;
        Map<String, String> definitionByDeployment = new LinkedHashMap<String, String>();

        try {
            for (String spec : args) {
                total++;
                String[] parts = spec.split("\\|");
                String filePath = parts[0];
                Map<String, Object> vars = parseVars(parts.length > 1 ? parts[1] : "");

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
                    }
                } catch (Exception e) {
                    System.out.println("[FAIL] " + label + "  部署失败: " + e.getClass().getSimpleName() + ": " + e.getMessage());
                    continue;
                }

                List<String> path = new ArrayList<String>();
                ProcessInstance pi;
                try {
                    pi = runtimeService.startProcessInstanceById(definitionId, vars);
                } catch (Exception e) {
                    System.out.println("[FAIL] " + label + "  启动实例失败: " + e.getClass().getSimpleName() + ": " + e.getMessage());
                    continue;
                }

                try {
                    int guard = 0;
                    while (guard++ < 40) {
                        List<Task> tasks = taskService.createTaskQuery()
                            .processInstanceId(pi.getId())
                            .orderByTaskCreateTime().asc()
                            .list();
                        if (tasks.isEmpty()) break;
                        for (Task t : tasks) {
                            path.add(stripTaskPrefix(t.getTaskDefinitionKey()) + "「" + safe(t.getName()) + "」");
                            taskService.complete(t.getId());
                        }
                    }
                } catch (Exception e) {
                    System.out.println("[FAIL] " + label + "  执行中断: " + e.getClass().getSimpleName() + ": " + e.getMessage());
                    System.out.println("       已走: " + join(path));
                    continue;
                }

                boolean ended = runtimeService.createProcessInstanceQuery()
                    .processInstanceId(pi.getId()).count() == 0;

                // 路径断言：expect=A>B>C 精确；expectcontains=k1,k2 表示必须都出现（并行场景）
                String expect = expectOf(parts);
                String expectContains = containsOf(parts);
                boolean assertOk = true;
                String why = "";

                if (expect != null) {
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

                if (ended && !path.isEmpty() && assertOk) {
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
                else if (v.matches("-?\\d+\\.\\d+")) vars.put(k, Double.valueOf(v));
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
        for (int i = 2; i < parts.length; i++) {
            if (parts[i].startsWith("expect=")) return parts[i].substring("expect=".length());
        }
        return null;
    }

    /** spec 形如 file|vars|expectcontains=k1,k2 */
    private static String containsOf(String[] parts) {
        for (int i = 2; i < parts.length; i++) {
            if (parts[i].startsWith("expectcontains=")) return parts[i].substring("expectcontains=".length());
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

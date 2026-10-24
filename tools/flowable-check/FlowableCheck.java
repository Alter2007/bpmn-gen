import org.flowable.bpmn.converter.BpmnXMLConverter;
import org.flowable.bpmn.model.BpmnModel;
import org.flowable.bpmn.model.FlowElement;
import org.flowable.bpmn.model.Process;
import org.flowable.validation.ProcessValidator;
import org.flowable.validation.ProcessValidatorFactory;
import org.flowable.validation.ValidationError;

import javax.xml.stream.XMLInputFactory;
import javax.xml.stream.XMLStreamReader;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.List;

/**
 * L4-轻量：用 Flowable 引擎自己的代码校验 BPMN。
 *
 * 做两件事：
 *   1. BpmnXMLConverter 解析 —— 引擎部署时走的就是这条路
 *   2. ProcessValidator 校验 —— 引擎 deploy 前的流程合法性检查
 *
 * 不做什么：不连数据库、不启动引擎、不跑实例。所以它是「引擎能读进来并接受」的证据，
 * 不等于「实例能跑通」。这条边界必须如实标注（P-10）。
 *
 * 用法：java -cp "{jar目录}\*" FlowableCheck.java <file.bpmn> [...]
 * 退出码：0 全部通过 / 1 有失败 / 2 参数或环境问题
 */
public class FlowableCheck {

    public static void main(String[] args) {
        if (args.length == 0) {
            System.out.println("用法: java -cp \"<jar目录>\\*\" FlowableCheck.java <file.bpmn> [...]");
            System.exit(2);
        }

        BpmnXMLConverter converter = new BpmnXMLConverter();
        ProcessValidator validator = new ProcessValidatorFactory().createDefaultProcessValidator();
        XMLInputFactory xmlFactory = XMLInputFactory.newInstance();

        int okCount = 0;
        int total = 0;

        for (String arg : args) {
            Path p = Paths.get(arg).toAbsolutePath();
            total++;
            if (!Files.exists(p)) {
                System.out.println("[FAIL] 文件不存在: " + p);
                continue;
            }

            System.out.println("== " + p.getFileName() + " ==");

            BpmnModel model;
            try (InputStream in = Files.newInputStream(p)) {
                XMLStreamReader reader = xmlFactory.createXMLStreamReader(in);
                model = converter.convertToBpmnModel(reader);
                reader.close();
            } catch (Exception e) {
                System.out.println("[FAIL] 引擎解析失败: " + e.getClass().getSimpleName() + ": " + e.getMessage());
                System.out.println("");
                continue;
            }

            List<Process> processes = model.getProcesses();
            StringBuilder summary = new StringBuilder();
            for (Process proc : processes) {
                int elements = proc.getFlowElements() == null ? 0 : proc.getFlowElements().size();
                int flows = 0;
                for (FlowElement fe : proc.getFlowElements()) {
                    if ("sequenceFlow".equals(fe.getClass().getSimpleName().replace("SequenceFlow", "sequenceFlow"))) flows++;
                }
                summary.append("  process ").append(proc.getId())
                       .append("  executable=").append(proc.isExecutable())
                       .append("  流程元素=").append(elements)
                       .append("  连线=").append(flows)
                       .append("\n");
            }

            List<ValidationError> errors = new ArrayList<ValidationError>();
            try {
                errors = validator.validate(model);
            } catch (Exception e) {
                System.out.println("[FAIL] 引擎校验异常: " + e.getClass().getSimpleName() + ": " + e.getMessage());
                System.out.println("");
                continue;
            }

            if (errors == null) errors = new ArrayList<ValidationError>();

            if (errors.isEmpty()) {
                System.out.print(summary);
                System.out.println("[OK] 引擎接受（解析 + 流程校验通过）");
                okCount++;
            } else {
                System.out.print(summary);
                System.out.println("[FAIL] 引擎校验发现 " + errors.size() + " 处问题:");
                for (ValidationError e : errors) {
                    System.out.println("  - [" + e.getValidatorSetName() + "] "
                            + (e.getActivityId() == null ? "" : e.getActivityId() + ": ")
                            + e.getDefaultDescription());
                }
            }
            System.out.println("");
        }

        System.out.println("通过 " + okCount + " / " + total);
        System.exit(okCount == total ? 0 : 1);
    }
}

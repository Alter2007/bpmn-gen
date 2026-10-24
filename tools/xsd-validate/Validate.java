import javax.xml.XMLConstants;
import javax.xml.transform.stream.StreamSource;
import javax.xml.validation.Schema;
import javax.xml.validation.SchemaFactory;
import javax.xml.validation.Validator;
import org.xml.sax.SAXParseException;
import org.xml.sax.helpers.DefaultHandler;

import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.List;

/**
 * L2：用 OMG 官方 BPMN 2.0 XSD 做规范级校验。
 *
 * 为什么单独写 Java：
 *   1. 我们的核心是零依赖 Node，不想为了校验引入 bpmn-moddle；
 *   2. 这台机器本来就有 JDK 17，且 JDK 11+ 支持直接运行单文件源码，
 *      不需要 Maven / Gradle / 编译产物，零安装、零残留（符合 P-02/P-03）。
 *
 * 用法：java Validate.java <file.bpmn> <xsdDir>
 * 退出码：0 通过 / 1 不通过 / 2 环境问题
 */
public class Validate {

    public static void main(String[] args) {
        if (args.length < 2) {
            System.out.println("用法: java Validate.java <file.bpmn> <xsd目录>");
            System.exit(2);
        }

        Path xml = Paths.get(args[0]).toAbsolutePath();
        Path dir = Paths.get(args[1]).toAbsolutePath();
        Path xsd = dir.resolve("BPMN20.xsd");

        if (!Files.exists(xml)) {
            System.out.println("[ERR] 找不到 XML: " + xml);
            System.exit(2);
        }
        if (!Files.exists(xsd)) {
            System.out.println("[ERR] 找不到 XSD: " + xsd);
            System.out.println("      先运行: node scripts/fetch-schema.js");
            System.exit(2);
        }

        try {
            SchemaFactory sf = SchemaFactory.newInstance(XMLConstants.W3C_XML_SCHEMA_NS_URI);
            // 传 File：相对 include/import 会按文件所在目录解析
            Schema schema = sf.newSchema(xsd.toFile());
            Validator v = schema.newValidator();
            v.setProperty(XMLConstants.ACCESS_EXTERNAL_DTD, "");
            v.setProperty(XMLConstants.ACCESS_EXTERNAL_SCHEMA, "");

            final List<String> errors = new ArrayList<String>();
            v.setErrorHandler(new DefaultHandler() {
                @Override
                public void error(SAXParseException e) {
                    errors.add("行 " + e.getLineNumber() + " 列 " + e.getColumnNumber() + ": " + e.getMessage());
                }

                @Override
                public void fatalError(SAXParseException e) throws SAXParseException {
                    errors.add("行 " + e.getLineNumber() + ": " + e.getMessage());
                    throw e;
                }

                @Override
                public void warning(SAXParseException e) {
                    // 忽略警告
                }
            });

            try {
                v.validate(new StreamSource(xml.toFile()));
            } catch (Exception e) {
                if (errors.isEmpty()) errors.add(String.valueOf(e.getMessage()));
            }

            if (errors.isEmpty()) {
                System.out.println("[OK] 符合 BPMN 2.0 官方 XSD: " + xml.getFileName());
                System.exit(0);
            }

            System.out.println("[FAIL] XSD 校验不通过（" + errors.size() + " 处）: " + xml.getFileName());
            for (String s : errors) System.out.println("  - " + s);
            System.exit(1);

        } catch (Exception e) {
            System.out.println("[ERR] 校验器初始化失败: " + e.getMessage());
            e.printStackTrace();
            System.exit(2);
        }
    }
}

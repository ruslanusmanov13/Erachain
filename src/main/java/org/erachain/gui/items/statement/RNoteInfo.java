package org.erachain.gui.items.statement;

import org.erachain.controller.Controller;
import org.erachain.core.BlockChain;
import org.erachain.core.account.Account;
import org.erachain.core.exdata.ExData;
import org.erachain.core.exdata.ExPays;
import org.erachain.core.exdata.exLink.ExLink;
import org.erachain.core.exdata.exLink.ExLinkAuthor;
import org.erachain.core.exdata.exLink.ExLinkSource;
import org.erachain.core.item.persons.PersonCls;
import org.erachain.core.item.templates.TemplateCls;
import org.erachain.core.transaction.RSignNote;
import org.erachain.core.transaction.Transaction;
import org.erachain.datachain.DCSet;
import org.erachain.gui.PasswordPane;
import org.erachain.gui.library.*;
import org.erachain.gui.transaction.RecDetailsFrame;
import org.erachain.lang.Lang;
import org.erachain.utils.MenuPopupUtil;
import org.erachain.utils.ZipBytes;
import org.json.simple.JSONObject;
import org.mapdb.Fun;
import org.mapdb.Fun.Tuple3;

import javax.swing.*;
import javax.swing.event.HyperlinkEvent;
import javax.swing.event.HyperlinkListener;
import java.awt.event.ActionEvent;
import java.awt.event.ActionListener;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.util.HashMap;
import java.util.Iterator;
import java.util.Map.Entry;
import java.util.Set;
import java.util.zip.DataFormatException;

/*
 * To change this license header, choose License Headers in Project Properties.
 * To change this template file, choose Tools | Templates
 * and open the template in the editor.
 */

/**
 * @author Саша
 */
@SuppressWarnings("serial")
public class RNoteInfo extends javax.swing.JPanel {

    public javax.swing.JPanel jPanel2;
    /**
     * Creates new form StatementInfo
     *
     * @param statement
     */
    RSignNote statement;
    RSignNote statementEncrypted;
    Transaction transaction;
    private MAttachedFilesPanel file_Panel;
    private SignLibraryPanel voush_Library_Panel;
    private javax.swing.JLabel jLabel_Title;
    private javax.swing.JPanel jPanel1;
    private MSplitPane jSplitPane1;
    private JTextPane jTextArea_Body;

    Controller cntr;

    public RNoteInfo(Transaction transaction) {

        cntr = Controller.getInstance();

        if (transaction == null)
            return;
        this.transaction = transaction;
        statement = (RSignNote) transaction;
        statement.parseDataFull();
        statement.calcFee(false);

        initComponents();

        viewInfo();
    }

    /**
     * This method is called from within the constructor to initialize the form.
     * WARNING: Do NOT modify this code. The content of this method is always
     * regenerated by the Form Editor.
     */

    //// <editor-fold defaultstate="collapsed" desc="Generated Code">
    private void initComponents() {
        java.awt.GridBagConstraints gridBagConstraints;

        jLabel_Title = new javax.swing.JLabel();
        jSplitPane1 = new MSplitPane();
        jPanel1 = new javax.swing.JPanel();
        new javax.swing.JScrollPane();

        jTextArea_Body = new JTextPane();
        jTextArea_Body.setContentType("text/html");
        jTextArea_Body.setEditable(false);


        jPanel2 = new javax.swing.JPanel();
        file_Panel = new MAttachedFilesPanel();
        file_Panel.setVisible(false);

        new javax.swing.JLabel();

        // jTable_Sign = new javax.swing.JTable();

        setLayout(new java.awt.GridBagLayout());

        JPanel pp = new RecDetailsFrame(transaction, true);

        gridBagConstraints = new java.awt.GridBagConstraints();
        gridBagConstraints.gridx = 0;
        gridBagConstraints.gridy = 0;
        gridBagConstraints.fill = java.awt.GridBagConstraints.HORIZONTAL;
        gridBagConstraints.anchor = java.awt.GridBagConstraints.FIRST_LINE_START;
        gridBagConstraints.weightx = 0.2;
        gridBagConstraints.insets = new java.awt.Insets(11, 11, 0, 11);
        add(pp, gridBagConstraints);

        jSplitPane1.setBorder(null);
        jSplitPane1.setOrientation(MSplitPane.VERTICAL_SPLIT);

        jPanel1.setLayout(new java.awt.GridBagLayout());
        int y = 0;

        // jTextArea_Body.setColumns(20);
        // jTextArea_Body.setRows(5);
        // jScrollPane3.setViewportView(jTextArea_Body);
        // jScrollPane3.getViewport().add(jTextArea_Body);
        jLabel_Title.setText(Lang.T("Title"));
        gridBagConstraints = new java.awt.GridBagConstraints();
        gridBagConstraints.gridx = 0;
        gridBagConstraints.gridy = ++y;
        gridBagConstraints.fill = java.awt.GridBagConstraints.HORIZONTAL;
        gridBagConstraints.anchor = java.awt.GridBagConstraints.FIRST_LINE_START;
        gridBagConstraints.weightx = 0.2;
        gridBagConstraints.insets = new java.awt.Insets(11, 11, 0, 11);
        jPanel1.add(jLabel_Title, gridBagConstraints);

        //jTextArea_Body.setWrapStyleWord(true);
        //jTextArea_Body.setLineWrap(true);

        MenuPopupUtil.installContextMenu(jTextArea_Body);
        //jTextArea_Body.setEditable(false);
        gridBagConstraints = new java.awt.GridBagConstraints();
        gridBagConstraints.fill = java.awt.GridBagConstraints.BOTH;
        gridBagConstraints.anchor = java.awt.GridBagConstraints.FIRST_LINE_START;
        gridBagConstraints.gridy = ++y;
        gridBagConstraints.weightx = 0.1;
        gridBagConstraints.weighty = 0.1;
        gridBagConstraints.insets = new java.awt.Insets(11, 11, 11, 11);

        JScrollPane scrol1 = new JScrollPane();
        scrol1.setViewportView(jTextArea_Body);
        jPanel1.add(scrol1, gridBagConstraints);

        if (statement.isEncrypted()) {
            JCheckBox encrypted = new JCheckBox(Lang.T("Encrypted"));
            encrypted.setSelected(true);
            gridBagConstraints = new java.awt.GridBagConstraints();
            gridBagConstraints.fill = java.awt.GridBagConstraints.HORIZONTAL;
            gridBagConstraints.anchor = java.awt.GridBagConstraints.FIRST_LINE_START;
            gridBagConstraints.gridy = ++y;
            gridBagConstraints.weightx = 0.1;
            gridBagConstraints.insets = new java.awt.Insets(11, 11, 11, 11);
            jPanel1.add(encrypted, gridBagConstraints);

            encrypted.addActionListener(new ActionListener() {
                public void actionPerformed(ActionEvent e) {
                    if (!encrypted.isSelected()) {
                        if (!cntr.isWalletUnlocked()) {
                            //ASK FOR PASSWORD
                            String password = PasswordPane.showUnlockWalletDialog(null);
                            if (!cntr.unlockWallet(password)) {
                                //WRONG PASSWORD
                                JOptionPane.showMessageDialog(null, Lang.T("Invalid password"), Lang.T("Unlock Wallet"), JOptionPane.ERROR_MESSAGE);

                                encrypted.setSelected(!encrypted.isSelected());

                                return;
                            }
                        }

                        statementEncrypted = statement;

                        Account account = cntr.getInvolvedAccount(statement);
                        Fun.Tuple3<Integer, String, RSignNote> result = statement.decrypt(account);
                        if (result.a < 0) {
                            JOptionPane.showMessageDialog(null,
                                    Lang.T(result.b == null ? "Not exists Account access" : result.b),
                                    Lang.T("Not decrypted"), JOptionPane.ERROR_MESSAGE);
                            encrypted.setSelected(!encrypted.isSelected());

                            return;

                        } else if (result.b != null) {
                            JOptionPane.showMessageDialog(null,
                                    Lang.T(" In pos: " + result.a + " - " + result.b),
                                    Lang.T("Not decrypted"), JOptionPane.ERROR_MESSAGE);
                            encrypted.setSelected(!encrypted.isSelected());

                            return;

                        }

                        statement = result.c;
                        statement.parseDataFull();
                        viewInfo();

                    } else if (statementEncrypted != null) {
                        // закроем доступ
                        statement = statementEncrypted;
                        viewInfo();
                    }
                }
            });

        }

        gridBagConstraints = new java.awt.GridBagConstraints();
        gridBagConstraints.fill = java.awt.GridBagConstraints.BOTH;
        gridBagConstraints.anchor = java.awt.GridBagConstraints.FIRST_LINE_START;
        gridBagConstraints.gridy = ++y;
        gridBagConstraints.weightx = 0.1;
        gridBagConstraints.weighty = 0.1;
        gridBagConstraints.insets = new java.awt.Insets(11, 11, 11, 11);
        jPanel1.add(file_Panel, gridBagConstraints);

        jSplitPane1.setLeftComponent(jPanel1);

        jPanel2.setLayout(new java.awt.GridBagLayout());

        gridBagConstraints = new java.awt.GridBagConstraints();
        gridBagConstraints.gridx = 0;
        gridBagConstraints.gridy = 1;
        gridBagConstraints.fill = java.awt.GridBagConstraints.BOTH;
        gridBagConstraints.anchor = java.awt.GridBagConstraints.FIRST_LINE_START;
        gridBagConstraints.weightx = 0.1;
        gridBagConstraints.weighty = 0.1;
        gridBagConstraints.insets = new java.awt.Insets(0, 11, 11, 11);
        voush_Library_Panel = new SignLibraryPanel(transaction);
        jPanel2.add(voush_Library_Panel, gridBagConstraints);
        //

        jSplitPane1.setRightComponent(jPanel2);

        gridBagConstraints = new java.awt.GridBagConstraints();
        gridBagConstraints.gridx = 0;
        gridBagConstraints.gridy = 1;
        gridBagConstraints.fill = java.awt.GridBagConstraints.BOTH;
        gridBagConstraints.anchor = java.awt.GridBagConstraints.FIRST_LINE_START;
        gridBagConstraints.weightx = 0.1;
        gridBagConstraints.weighty = 0.1;
        add(jSplitPane1, gridBagConstraints);

        jTextArea_Body.addHyperlinkListener(new HyperlinkListener() {

            @Override
            public void hyperlinkUpdate(HyperlinkEvent arg0) {
                // TODO Auto-generated method stub
                if (arg0.getEventType() != HyperlinkEvent.EventType.ACTIVATED) return;

                String fileName = arg0.getDescription();

                FileChooser chooser = new FileChooser();
                chooser.setDialogTitle(Lang.T("Save File") + ": " + fileName);
                //chooser.setFileSelectionMode(JFileChooser.FILES_ONLY);
                chooser.setDialogType(javax.swing.JFileChooser.SAVE_DIALOG);
                chooser.setMultiSelectionEnabled(false);
                chooser.setFileSelectionMode(JFileChooser.DIRECTORIES_ONLY);
                //chooser.setAcceptAllFileFilterUsed(false);

                if (chooser.showSaveDialog(getParent()) == JFileChooser.APPROVE_OPTION) {

                    String pp = chooser.getSelectedFile().getPath() + File.separatorChar + fileName;

                    File ff = new File(pp);
                    // if file
                    if (ff.exists() && ff.isFile()) {
                        int aaa = JOptionPane.showConfirmDialog(chooser,
                                Lang.T("File") + " " + fileName
                                        + " " + Lang.T("Exists") + "! "
                                        + Lang.T("Overwrite") + "?", Lang.T("Message"),
                                JOptionPane.OK_CANCEL_OPTION, JOptionPane.INFORMATION_MESSAGE);
                        if (aaa != 0) {
                            return;
                        }
                        ff.delete();

                    }

                    try (FileOutputStream fos = new FileOutputStream(pp)) {
                        ExData exData = statement.getExData();
                        HashMap<String, Tuple3<byte[], Boolean, byte[]>> items = exData.getFiles();
                        Tuple3<byte[], Boolean, byte[]> fileItem = items.get(fileName);
                        byte[] buffer = fileItem.c;
                        // if ZIP
                        if (fileItem.b) {
                            byte[] buffer1 = null;
                            try {
                                buffer1 = ZipBytes.decompress(buffer);
                            } catch (DataFormatException e1) {
                                System.out.println(e1.getMessage());
                            }
                            fos.write(buffer1, 0, buffer1.length);
                        } else {
                            fos.write(buffer, 0, buffer.length);
                        }

                    } catch (IOException ex) {

                        System.out.println(ex.getMessage());
                    }

                }


            }
        });

    }// </editor-fold>

    public void delay_on_Close() {
        voush_Library_Panel.delay_on_close();
    }

    @SuppressWarnings("unchecked")
    private void viewInfo() {

        String resultStr = "";
        ExData exData;

        exData = statement.getExData();
        exData.setDC(DCSet.getInstance());

        ExLink exLink = exData.getExLink();
        if (exLink != null) {
            resultStr += Lang.T("Link Type") + ": " + Lang.T(exData.viewLinkTypeName()) + " "
                    + Lang.T("for # для") + " " + Transaction.viewDBRef(exLink.getRef());
            Transaction transaction = DCSet.getInstance().getTransactionFinalMap().get(exLink.getRef());
            resultStr += "<br>" + transaction.getTitle() + " : " + transaction.getCreator().getPersonAsString() + "</b><br>";

        }

        ExPays exPays = exData.getExPays();
        if (exPays != null) {
            exPays.getFilteredAccruals(statement);
            resultStr += "<h3>" + Lang.T("Accruals") + "</h3>";
            resultStr += Lang.T("Count # кол-во") + ": <b>" + exPays.getFilteredAccrualsCount()
                    + "</b>, " + Lang.T("Additional Fee") + ": <b>" + BlockChain.feeBG(exPays.getTotalFeeBytes())
                    + "</b>, " + Lang.T("Total") + ": <b>" + exPays.getTotalPay();
        }

        String title = exData.getTitle();
        if (title != null)
            jLabel_Title.setText(Lang.T("Title") + ": " + title);

        if (exData.isCanSignOnlyRecipients()) {
            resultStr += "<br><b>" + Lang.T("To sign can only Recipients") + "<b><br>";
        }

        // recipients
        if (exData.hasRecipients()) {
            resultStr += "<h2>" + Lang.T("Recipients") + "</h2>";
            Account[] recipients = exData.getRecipients();
            int size = recipients.length;
            for (int i = 1; i <= size; ++i) {
                if (i > 7 && size > 10) {
                    resultStr += "... <br>";
                    i = size;
                }
                resultStr += i + " " + recipients[i - 1].getAddress() + "<br>";
            }
            resultStr += "<br>";
        }

        // AUTHORS
        if (exData.hasAuthors()) {
            resultStr += "<h2>" + Lang.T("Authors") + "</h2>";
            ExLinkAuthor[] authors = exData.getAuthors();
            int size = authors.length;
            for (int i = 1; i <= size; ++i) {
                if (i > 7 && size > 10) {
                    resultStr += "... <br>";
                    i = size;
                }

                PersonCls person = cntr.getPerson(authors[i - 1].getRef());
                String memo = authors[i - 1].getMemo();

                resultStr += i + ". " + authors[i - 1].getValue() + " x " + person.toString(cntr.getDCSet()) + (memo == null ? "" : " - " + memo) + "<br>";
            }
            resultStr += "<br>";
        }

        if (exData.isEncrypted()) {
            resultStr += "<h3>" + Lang.T("Encrypted") + "</h3><br>";
        }

        long templateKey = exData.getTemplateKey();
        if (templateKey > 0) {
            TemplateCls template = exData.getTemplate();
            resultStr += "<h2>" + template.toString(DCSet.getInstance()) + "</h2>";
            String valuedText = exData.getValuedText();
            if (valuedText != null) {
                resultStr += Library.to_HTML(valuedText);
            }
            resultStr += "<hr><br>";

            JSONObject params = exData.getTemplateValues();
            if (params != null) {
                resultStr += " <h3>" + Lang.T("Template Values") + "</h3>";
                Set<String> keys = params.keySet();
                for (String key : keys) {
                    resultStr += key + ": " + params.get(key) + "<br>";
                }
            }
        }

        String message = exData.getMessage();
        if (message != null) {
            resultStr += Library.to_HTML(message) + "<br><br>";
        }

        if (exData.hasHashes()) {
            // hashes
            JSONObject hashes = exData.getHashes();
            resultStr += "<h3>" + Lang.T("Hashes") + "</h3>";
            int i = 1;
            for (Object s : hashes.keySet()) {
                resultStr += i + " " + s + " " + hashes.get(s) + "<br>";
            }
            resultStr += "<br";
        }

        if (exData.hasFiles()) {
            HashMap<String, Tuple3<byte[], Boolean, byte[]>> files = exData.getFiles();
            Iterator<Entry<String, Tuple3<byte[], Boolean, byte[]>>> it_Files = files.entrySet().iterator();
            resultStr += "<h3>" + Lang.T("Files") + "</h3>";
            if (true) {
                int i = 1;
                while (it_Files.hasNext()) {
                    Entry<String, Tuple3<byte[], Boolean, byte[]>> file = it_Files.next();
                    boolean zip = new Boolean(file.getValue().b);
                    String fileName = file.getKey();
                    resultStr += i++ + ". <a href=" + fileName + ">"
                            + fileName + (zip ? " (" + Lang.T("Zipped") + ")" : "")
                            + "</a>" + " - "
                            + (file.getValue().c.length > 20000 ? (file.getValue().c.length >> 10) + "kB" : file.getValue().c.length + "B") + "<br>";
                }
                resultStr += "<br";
            } else {
                while (it_Files.hasNext()) {
                    Entry<String, Tuple3<byte[], Boolean, byte[]>> file = it_Files.next();
                    boolean zip = new Boolean(file.getValue().b);
                    String name_File = file.getKey();
                    byte[] file_byte = file.getValue().c;
                    file_Panel.addRow(name_File, zip, file_byte);
                }
                file_Panel.fireTableDataChanged();
            }

        } else if (statementEncrypted != null) {
            file_Panel.clear();
        }

        // AUTHORS
        if (exData.hasSources()) {
            resultStr += "<h2>" + Lang.T("Sources") + "</h2>";
            ExLinkSource[] sources = exData.getSources();
            int size = sources.length;
            for (int i = 1; i <= size; ++i) {
                if (i > 7 && size > 10) {
                    resultStr += "... <br>";
                    i = size;
                }

                Transaction sourceTx = cntr.getTransaction(sources[i - 1].getRef());
                String memo = sources[i - 1].getMemo();

                resultStr += i + ". " + sources[i - 1].getValue() + " x " + sourceTx.toStringFullAndCreatorLang() + (memo == null ? "" : " - " + memo) + "<br>";
            }
            resultStr += "<br>";
        }

        if (exData.getTags() != null) {
            resultStr += "<h4>" + Lang.T("Tags") + "</h4>";
            resultStr += statement.getExTags();

        }

        int fontSize = UIManager.getFont("Label.font").getSize();

        resultStr = "<head><style>"
                + " h1{ font-size: " + (fontSize + 5) + "px;  } "
                + " h2{ font-size: " + (fontSize + 3) + "px;  }"
                + " h3{ font-size: " + (fontSize + 1) + "px;  }"
                + " h4{ font-size: " + fontSize + "px;  }"
                + " h5{ font-size: " + (fontSize - 1) + "px;  }"
                + " body{ font-family:"
                + UIManager.getFont("Label.font").getFamily() + "; font-size:" + fontSize + "px;"
                + "word-wrap:break-word;}"
                + "</style> </head><body>" + resultStr
                + "</body>";

        jTextArea_Body.setText(resultStr);
    }
}

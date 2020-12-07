package org.erachain.gui.items.templates;

import org.erachain.controller.Controller;
import org.erachain.core.account.Account;
import org.erachain.core.account.PrivateKeyAccount;
import org.erachain.core.exdata.exLink.ExLink;
import org.erachain.core.exdata.exLink.ExLinkAppendix;
import org.erachain.core.item.ItemCls;
import org.erachain.core.item.assets.AssetCls;
import org.erachain.core.transaction.IssueTemplateRecord;
import org.erachain.core.transaction.Transaction;
import org.erachain.gui.Gui;
import org.erachain.gui.MainFrame;
import org.erachain.gui.items.IssueItemPanel;
import org.erachain.gui.items.TypeOfImage;
import org.erachain.gui.library.AddImageLabel;
import org.erachain.gui.library.IssueConfirmDialog;
import org.erachain.gui.library.Library;
import org.erachain.gui.models.AccountsComboBoxModel;
import org.erachain.gui.transaction.IssueTemplateDetailsFrame;
import org.erachain.gui.transaction.OnDealClick;
import org.erachain.lang.Lang;

import javax.swing.*;
import java.awt.*;

import static org.erachain.gui.items.utils.GUIConstants.*;
import static org.erachain.gui.items.utils.GUIUtils.checkWalletUnlock;

@SuppressWarnings("serial")
public class IssueTemplatePanel extends IssueItemPanel {

    public static String NAME = "IssueTemplatePanel";
    public static String TITLE = "Issue Template";

    private JComboBox<Account> jComboBoxAccountCreator = new JComboBox<>(new AccountsComboBoxModel());
    private JButton jButtonCreate = new JButton();
    private JLabel jLabelAccountCreator = new JLabel();
    private JLabel jLabelContent = new JLabel();
    private JLabel jLabelFee = new JLabel();
    private JLabel jLabelIssueTemplate = new JLabel();
    private JLabel jLabelTitle = new JLabel();
    private JScrollPane jScrollPane1 = new JScrollPane();
    private JTextArea jTextAreaContent = new JTextArea();
    private JComboBox<String> txtFeePow = new JComboBox<>();
    private JTextField jTextFieldTitle = new JTextField();
    private AddImageLabel addImageLabel;
    private AddImageLabel addLogoIconPanel;

    public IssueTemplatePanel() {
        super(NAME, TITLE);

        initComponents();
        setVisible(true);
    }

    public void onIssueClick() {
        // DISABLE
        jButtonCreate.setEnabled(false);
        if (checkWalletUnlock(jButtonCreate)) {
            return;
        }
        // READ CREATOR
        Account sender = (Account) jComboBoxAccountCreator.getSelectedItem();

        ExLink exLink = null;
        Long linkRef = Transaction.parseDBRef(exLinkText.getText());
        if (linkRef != null) {
            exLink = new ExLinkAppendix(linkRef);
        }

        int feePow;
        try {
            // READ FEE POW
            feePow = Integer.parseInt((String) txtFeePow.getSelectedItem());
        } catch (Exception e) {
            JOptionPane.showMessageDialog(new JFrame(), Lang.getInstance().translate("Invalid fee!"),
                    Lang.getInstance().translate("Error"), JOptionPane.ERROR_MESSAGE);
            // ENABLE
            jButtonCreate.setEnabled(true);
            return;
        }

        byte[] icon = addLogoIconPanel.getImgBytes();
        byte[] image = addImageLabel.getImgBytes();

        // CREATE PLATE
        PrivateKeyAccount creator = Controller.getInstance().getWalletPrivateKeyAccountByAddress(sender.getAddress());
        if (creator == null) {
            JOptionPane.showMessageDialog(new JFrame(),
                    Lang.getInstance().translate(OnDealClick.resultMess(Transaction.PRIVATE_KEY_NOT_FOUND)),
                    Lang.getInstance().translate("Error"), JOptionPane.ERROR_MESSAGE);
            return;
        }

        IssueTemplateRecord issueTemplate = (IssueTemplateRecord) Controller.getInstance().issueTemplate(creator,
                exLink, jTextFieldTitle.getText(), jTextAreaContent.getText(), icon, image, feePow);

        String text = "<HTML><body>";
        text += Lang.getInstance().translate("Confirmation transaction issue template") + "<br><br><br>";
        text += Lang.getInstance().translate("Creator") + ":&nbsp;" + issueTemplate.getCreator() + "<br>";
        text += Lang.getInstance().translate("Title") + ":&nbsp;" + issueTemplate.getItem().viewName() + "<br>";
        text += Lang.getInstance().translate("Description") + ":<br>"
                + Library.to_HTML(issueTemplate.getItem().getDescription()) + "<br>";
        String Status_text = "";

        IssueConfirmDialog issueConfirmDialog = new IssueConfirmDialog(MainFrame.getInstance(), true, issueTemplate,
                text, (int) (getWidth() / 1.2), (int) (getHeight() / 1.2), Status_text,
                Lang.getInstance().translate("Confirmation transaction issue template"));
        IssueTemplateDetailsFrame issueTemplateDetailsFrame = new IssueTemplateDetailsFrame(issueTemplate);
        issueConfirmDialog.jScrollPane1.setViewportView(issueTemplateDetailsFrame);
        issueConfirmDialog.setLocationRelativeTo(this);
        issueConfirmDialog.setVisible(true);
        // JOptionPane.OK_OPTION
        if (!issueConfirmDialog.isConfirm) {
            jButtonCreate.setEnabled(true);
            return;
        }
        // VALIDATE AND PROCESS
        int result = Controller.getInstance().getTransactionCreator().
                afterCreate(issueTemplate, Transaction.FOR_NETWORK);
        // CHECK VALIDATE MESSAGE
        switch (result) {
            case Transaction.VALIDATE_OK:
                JOptionPane.showMessageDialog(new JFrame(), Lang.getInstance().translate("Template issue has been sent") + "!",
                        Lang.getInstance().translate("Success"), JOptionPane.INFORMATION_MESSAGE);
                break;

            case Transaction.NOT_ENOUGH_FEE:
                JOptionPane.showMessageDialog(new JFrame(),
                        Lang.getInstance().translate("Not enough %fee% balance!").
                                replace("%fee%", AssetCls.FEE_NAME),
                        Lang.getInstance().translate("Error"), JOptionPane.ERROR_MESSAGE);
                break;

            case Transaction.INVALID_NAME_LENGTH_MIN:
                JOptionPane.showMessageDialog(new JFrame(),
                        Lang.getInstance().translate("Name must be more then %val characters!")
                                .replace("%val", "" + issueTemplate.getItem().getMinNameLen()),
                        Lang.getInstance().translate("Error"), JOptionPane.ERROR_MESSAGE);
                break;
            case Transaction.INVALID_NAME_LENGTH_MAX:
                JOptionPane.showMessageDialog(MainFrame.getInstance(),
                        Lang.getInstance().translate("Name must be less then %val characters!")
                                .replace("%val", "" + ItemCls.MAX_NAME_LENGTH),
                        Lang.getInstance().translate("Error"), JOptionPane.ERROR_MESSAGE);
                break;

            case Transaction.INVALID_DESCRIPTION_LENGTH_MAX:
                JOptionPane.showMessageDialog(new JFrame(),
                        Lang.getInstance().translate("Description must be between 1 and 1000 characters!"),
                        Lang.getInstance().translate("Error"), JOptionPane.ERROR_MESSAGE);
                break;

            case Transaction.CREATOR_NOT_PERSONALIZED:
                JOptionPane.showMessageDialog(new JFrame(),
                        Lang.getInstance().translate("Issuer account not personalized!"),
                        Lang.getInstance().translate("Error"), JOptionPane.ERROR_MESSAGE);
                break;
            default:
                JOptionPane.showMessageDialog(new JFrame(),
                        Lang.getInstance().translate("Unknown error") + "[" + result + "]!",
                        Lang.getInstance().translate("Error"), JOptionPane.ERROR_MESSAGE);
                break;
        }

        // ENABLE
        jButtonCreate.setEnabled(true);
    }

    private void initComponents() {
        setLayout(new GridBagLayout());
        GridBagConstraints gridBagConstraints;

        jLabelIssueTemplate.setHorizontalAlignment(SwingConstants.CENTER);
        jLabelIssueTemplate.setText(Lang.getInstance().translate("Issue Template"));
        jLabelIssueTemplate.setFont(FONT_TITLE);
        gridBagConstraints = new GridBagConstraints();
        gridBagConstraints.gridx = 0;
        gridBagConstraints.gridy = 0;
        gridBagConstraints.gridwidth = 8;
        gridBagConstraints.fill = GridBagConstraints.HORIZONTAL;
        gridBagConstraints.weightx = 0.1;
        gridBagConstraints.insets = new Insets(12, 15, 5, 15);
        add(jLabelIssueTemplate, gridBagConstraints);

        addImageLabel = new AddImageLabel(
                Lang.getInstance().translate("Add image"), WIDTH_IMAGE, HEIGHT_IMAGE, TypeOfImage.JPEG,
                0, ItemCls.MAX_IMAGE_LENGTH, WIDTH_IMAGE_INITIAL, HEIGHT_IMAGE_INITIAL);
        gridBagConstraints = new GridBagConstraints();
        gridBagConstraints.gridheight = 2;
        gridBagConstraints.gridx = 0;
        gridBagConstraints.gridy = 2;
        gridBagConstraints.anchor = GridBagConstraints.NORTHWEST;
        gridBagConstraints.insets = new Insets(0, 12, 8, 8);
        add(addImageLabel, gridBagConstraints);

        addLogoIconPanel = new AddImageLabel(Lang.getInstance().translate("Add Logo"),
                WIDTH_LOGO, HEIGHT_LOGO, TypeOfImage.GIF,
                0, ItemCls.MAX_ICON_LENGTH, WIDTH_LOGO_INITIAL, HEIGHT_LOGO_INITIAL);
        gridBagConstraints = new GridBagConstraints();
        gridBagConstraints.insets = new Insets(0, 0, 5, 0);
        gridBagConstraints.gridx = 0;
        gridBagConstraints.gridy = 5;
        add(addLogoIconPanel, gridBagConstraints);

        jLabelAccountCreator.setText(Lang.getInstance().translate("Account Creator") + ":");
        gridBagConstraints = new GridBagConstraints();
        gridBagConstraints.gridx = 1;
        gridBagConstraints.gridy = 1;
        gridBagConstraints.anchor = GridBagConstraints.SOUTHWEST;
        gridBagConstraints.insets = new Insets(0, 15, 5, 5);
        add(jLabelAccountCreator, gridBagConstraints);

        jLabelTitle.setText(Lang.getInstance().translate("Title") + ":");
        gridBagConstraints = new GridBagConstraints();
        gridBagConstraints.gridx = 1;
        gridBagConstraints.gridy = 2;
        gridBagConstraints.anchor = GridBagConstraints.EAST;
        gridBagConstraints.insets = new Insets(0, 15, 5, 5);
        add(jLabelTitle, gridBagConstraints);

        jLabelContent.setText(Lang.getInstance().translate("Content") + ":");
        gridBagConstraints = new GridBagConstraints();
        gridBagConstraints.gridx = 1;
        gridBagConstraints.gridy = 3;
        gridBagConstraints.anchor = GridBagConstraints.NORTHEAST;
        gridBagConstraints.insets = new Insets(0, 15, 5, 5);
        add(jLabelContent, gridBagConstraints);

        jLabelFee.setText(Lang.getInstance().translate("Fee Power") + ":");
        jLabelFee.setVisible(Gui.SHOW_FEE_POWER);
        gridBagConstraints = new GridBagConstraints();
        gridBagConstraints.gridx = 1;
        gridBagConstraints.gridy = 6;
        gridBagConstraints.anchor = GridBagConstraints.LINE_END;
        gridBagConstraints.insets = new Insets(0, 15, 5, 5);
        add(jLabelFee, gridBagConstraints);


        gridBagConstraints = new GridBagConstraints();
        gridBagConstraints.gridx = 2;
        gridBagConstraints.gridy = 1;
        gridBagConstraints.gridwidth = 2;
        gridBagConstraints.fill = GridBagConstraints.HORIZONTAL;
        gridBagConstraints.anchor = GridBagConstraints.SOUTH;
        gridBagConstraints.weightx = 0.1;
        gridBagConstraints.insets = new Insets(0, 0, 5, 15);
        add(jComboBoxAccountCreator, gridBagConstraints);


        gridBagConstraints = new GridBagConstraints();
        gridBagConstraints.gridx = 2;
        gridBagConstraints.gridy = 2;
        gridBagConstraints.gridwidth = 2;
        gridBagConstraints.fill = GridBagConstraints.HORIZONTAL;
        gridBagConstraints.anchor = GridBagConstraints.FIRST_LINE_START;
        gridBagConstraints.weightx = 0.1;
        gridBagConstraints.insets = new Insets(0, 0, 5, 15);
        add(jTextFieldTitle, gridBagConstraints);


        jTextAreaContent.setColumns(20);
        jTextAreaContent.setLineWrap(true);
        jTextAreaContent.setRows(18);
        jTextAreaContent.setAlignmentY(1F);
        jScrollPane1.setViewportView(jTextAreaContent);

        gridBagConstraints = new GridBagConstraints();
        gridBagConstraints.gridx = 2;
        gridBagConstraints.gridy = 3;
        gridBagConstraints.gridwidth = 2;
        gridBagConstraints.gridheight = 3;
        gridBagConstraints.fill = GridBagConstraints.BOTH;
        gridBagConstraints.anchor = GridBagConstraints.FIRST_LINE_START;
        gridBagConstraints.weightx = 0.1;
        gridBagConstraints.weighty = 0.7;
        gridBagConstraints.insets = new Insets(0, 0, 5, 15);
        add(jScrollPane1, gridBagConstraints);


        txtFeePow.setToolTipText("Level of FEE Power");
        txtFeePow.setModel(new DefaultComboBoxModel<>(new String[]{"0", "1", "2", "3", "4", "5", "6", "7", "8"}));
        txtFeePow.setSelectedIndex(0);
        txtFeePow.setVisible(Gui.SHOW_FEE_POWER);
        txtFeePow.setPreferredSize(new Dimension(80, 20));

        gridBagConstraints = new GridBagConstraints();
        gridBagConstraints.insets = new Insets(0, 0, 5, 5);
        gridBagConstraints.gridx = 3;
        gridBagConstraints.gridy = 6;
        gridBagConstraints.gridwidth = 2;
        gridBagConstraints.fill = GridBagConstraints.HORIZONTAL;
        gridBagConstraints.weightx = 0.1;
        gridBagConstraints.anchor = GridBagConstraints.LINE_START;
        add(txtFeePow, gridBagConstraints);

        jButtonCreate.setText(Lang.getInstance().translate("Create"));
        jButtonCreate.setRequestFocusEnabled(false);
        jButtonCreate.addActionListener(e -> onIssueClick());

        gridBagConstraints = new GridBagConstraints();
        gridBagConstraints.gridx = 3;
        gridBagConstraints.gridy = 7;
        gridBagConstraints.anchor = GridBagConstraints.LINE_START;
        gridBagConstraints.insets = new Insets(0, 0, 5, 15);
        add(jButtonCreate, gridBagConstraints);
    }

}